/**
 * Every environment this process is holding.
 *
 * They live together because each one costs its overlay and nothing more: a few
 * hundred bytes for an untouched fork, kilobytes for a busy one. Hundreds fit in
 * one process, which is the whole reason this design is worth building — a chain
 * per sandbox does not.
 */
import { randomUUID } from "node:crypto";
import { Environment } from "./environment.ts";
import { Store, type EnvironmentSummary } from "./store.ts";
import type { Meter } from "./meter.ts";

/**
 * Raised when an environment was written by someone else while we held it.
 *
 * Its own type so the server can tell it apart from a real failure: the caller
 * should try again, and a retry will succeed, which is a different thing to say
 * than "something went wrong".
 */
/** Why an environment was told to stop, and when. */
export interface Suspension { reason: string; at: number }

const SUSPENSION_TTL = 10_000;

export class StaleEnvironment extends Error {
    readonly id: string;

    constructor(id: string) {
        super(`Environment "${id}" was changed by another process; nothing was written.`);
        this.name = "StaleEnvironment";
        this.id = id;
    }
}
import type { UpstreamCache } from "./upstream-cache.ts";

export interface CreateOptions {
    rpcUrl: string;
    followHead?: boolean;
    checkpoint?: number;
    name?: string;
    chainId?: number;
    forkBlock?: bigint;
}

/**
 * What every environment gets unless its own request says otherwise.
 *
 * The chain id belongs here rather than on the one preset environment: a wallet
 * that recognises the parent's id answers some questions from its own services
 * instead of from the fork, and a fork made through the API deserves the same
 * protection as the one made at startup.
 */
export interface ManagerDefaults {
    cache?: UpstreamCache | null;
    checkpoint?: number;
    chainId?: number;
    /** Seconds between head syncs for environments that follow it; 0 turns it off. */
    syncInterval?: number;
    /** Where each environment's cold reads are counted, if anywhere. */
    meter?: Meter | null;
}

interface Held {
    env: Environment;
    /** The revision last written out, so an unchanged environment is not rewritten. */
    persisted?: number;
    /**
     * The row version this process believes is in the store.
     *
     * Kept here rather than read back before each write: the read was a round
     * trip on the path of every transaction, and the number only ever changes
     * when this process writes — or when another one does, which is precisely
     * the case this is here to detect.
     */
    revision: number;
    rpcUrl: string;
    name: string;
    createdAt: number;
}

export class Manager {
    private readonly live = new Map<string, Held>();
    private readonly store: Store;
    private readonly meter: Meter | null = null;
    private readonly cache: UpstreamCache | null;
    private readonly checkpoint: number;
    private readonly chainId: number | undefined;
    private readonly syncInterval: number;
    private syncTimer: ReturnType<typeof setInterval> | null = null;

    constructor(store: Store, defaults: ManagerDefaults = {}) {
        this.store = store;
        this.cache = defaults.cache ?? null;
        this.checkpoint = defaults.checkpoint ?? 0;
        this.chainId = defaults.chainId;
        this.syncInterval = defaults.syncInterval ?? 0;
        this.meter = defaults.meter ?? null;
        if (this.syncInterval > 0) {
            this.syncTimer = setInterval(() => void this.syncFollowers(), this.syncInterval * 1000);
            // A sync is housekeeping; it should never be the reason a process stays up.
            this.syncTimer.unref?.();
        }
    }

    /**
     * Pulls every environment that follows the head up to the parent's latest block.
     *
     * Only live environments are touched. Waking a stored one to move its fork
     * point would mean paying to re-read state for a fork nobody is using.
     */
    async syncFollowers(): Promise<void> {
        for (const [ id, held ] of this.live) {
            if (!held.env.followsHead) continue;
            try {
                if ((await held.env.syncToHead()).advanced) await this.persist(id);
            } catch (error) {
                // A parent that is briefly unreachable is not a reason to stop
                // syncing the others, or to take the process down.
                console.error(`sync ${id}:`, error instanceof Error ? error.message : error);
            }
        }
    }

    /** Stops the background sync, for a process that wants to exit cleanly. */
    stop(): void {
        if (this.syncTimer) clearInterval(this.syncTimer);
        this.syncTimer = null;
    }

    async create(options: CreateOptions): Promise<{ id: string; env: Environment }> {
        const id = randomUUID().slice(0, 8);
        const env = await Environment.create({
            rpcUrl: options.rpcUrl,
            chainId: options.chainId ?? this.chainId,
            forkBlock: options.forkBlock,
            checkpoint: options.checkpoint ?? this.checkpoint,
            cache: this.cache,
        });
        env.followsHead = options.followHead ?? false;
        this.archive(id, env);
        this.measure(id, env);
        this.live.set(id, {
            env,
            rpcUrl: options.rpcUrl,
            name: options.name ?? `fork-${id}`,
            createdAt: Date.now(),
            // Nothing is in the store yet; the first write claims the row.
            revision: 0,
        });
        await this.persist(id);
        return { id, env };
    }

    /**
     * The environment for an id, woken from the store if this process has not got it.
     *
     * A restart therefore costs nothing visible: the first request for an
     * environment rebuilds it from its overlay, and the parent chain fills in the
     * rest lazily exactly as it did the first time.
     */
    async get(id: string): Promise<Environment | null> {
        const held = this.live.get(id);
        if (held) return held.env;

        const saved = await this.store.load(id);
        if (!saved) return null;

        const env = await Environment.restore(saved.overlay, saved.rpcUrl, saved.chain, this.cache);
        // Otherwise an environment that was following the head quietly stops
        // doing so the first time the process restarts.
        env.followsHead = saved.followsHead;
        this.archive(id, env);
        this.measure(id, env);
        this.live.set(id, {
            env, rpcUrl: saved.rpcUrl, name: saved.name, createdAt: saved.createdAt,
            revision: saved.revision,
        });
        return env;
    }

    async list(): Promise<EnvironmentSummary[]> {
        return await this.store.list();
    }

    /**
     * Whether an environment has been told to stop, remembered briefly.
     *
     * Asked on every request and every socket message, so it cannot be a query
     * each time. Ten seconds is also the longest another replica can go on
     * serving after a suspension lands on this one — this replica hears about
     * its own at once.
     */
    private readonly suspensions = new Map<string, { value: Suspension | null; at: number }>();
    private readonly suspendedListeners = new Set<(id: string, reason: string) => void>();

    async suspension(id: string): Promise<Suspension | null> {
        const held = this.suspensions.get(id);
        if (held && Date.now() - held.at < SUSPENSION_TTL) return held.value;
        let value: Suspension | null;
        try {
            value = await this.store.suspension(id);
        } catch (error) {
            // If the store cannot say, keep serving. Refusing every request
            // because a lookup failed turns a database blip into an outage.
            console.error(`could not read the suspension for ${id}:`, error);
            return held?.value ?? null;
        }
        this.suspensions.set(id, { value, at: Date.now() });
        return value;
    }

    /** Stops an environment answering, or lets it answer again with `null`. */
    async setSuspension(id: string, reason: string | null): Promise<void> {
        if (reason === null) {
            await this.store.unsuspend(id);
            this.suspensions.set(id, { value: null, at: Date.now() });
            return;
        }
        await this.store.suspend(id, reason);
        this.suspensions.set(id, { value: { reason, at: Date.now() }, at: Date.now() });
        for (const listener of this.suspendedListeners) {
            try { listener(id, reason); } catch (error) { console.error("a suspension listener threw:", error); }
        }
    }

    /** Told the moment this process suspends something, so open sockets can be shut. */
    onSuspended(listener: (id: string, reason: string) => void): () => void {
        this.suspendedListeners.add(listener);
        return () => { this.suspendedListeners.delete(listener); };
    }

    async delete(id: string): Promise<boolean> {
        this.live.delete(id);
        // The traces go with it. Left behind they would be unreachable rows that
        // nothing ever deletes, growing for the life of the database.
        await this.store.deleteTraces(id);
        // So do the alerts, and for a second reason: an alert outliving its
        // environment is a URL this engine would keep posting to for nothing.
        await this.store.deleteAlerts(id);
        await this.store.unsuspend(id);
        this.suspensions.delete(id);
        return this.store.delete(id);
    }

    /**
     * Points an environment's traces at the store, under its own id.
     *
     * Done here rather than in `Environment` because an environment does not know
     * what it is called — the id belongs to the manager that handed it out.
     */
    /**
     * Points an environment's cold reads at the meter, under its own id.
     *
     * Same reason as the archive: the environment does not know what it is
     * called, and attribution is the whole point.
     */
    private measure(id: string, env: Environment): void {
        if (!this.meter) return;
        env.onUpstreamFetch = () => this.meter!.miss(id);
        env.onForwarded = () => this.meter!.forward(id);
        env.usageReader = async (days) => {
            const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
            const written = await this.store.readUsage(id, since);
            // Plus whatever has happened since the last flush, so the number a
            // person is looking at is not up to half a minute behind.
            const live = this.meter!.unflushed(id);
            const total = written.reduce(
                (sum, d) => ({
                    requests: sum.requests + d.requests,
                    misses: sum.misses + d.misses,
                    forwarded: sum.forwarded + d.forwarded,
                }),
                { requests: 0, misses: 0, forwarded: 0 });
            return {
                days: written,
                total: {
                    requests: total.requests + live.requests,
                    misses: total.misses + live.misses,
                    forwarded: total.forwarded + live.forwarded,
                },
                pending: live,
            };
        };
    }

    private archive(id: string, env: Environment): void {
        env.archive = {
            save: async (hash, trace, diff) => {
                await this.store.saveTrace(id, hash, JSON.stringify(trace), JSON.stringify(diff));
            },
            load: async (hash) => {
                const found = await this.store.loadTrace(id, hash);
                if (!found) return null;
                return {
                    trace: JSON.parse(found.trace),
                    diff: found.diff === "null" ? null : JSON.parse(found.diff),
                };
            },
        };
    }

    /**
     * Writes an environment out, unless another process has written it since.
     *
     * Throws `StaleEnvironment` when it has. That is not a failure to be logged
     * and swallowed: whatever this process just did was built on state that is no
     * longer current, so it cannot be saved and must not be reported as saved.
     * The environment is dropped so the next request reloads the current one.
     */
    async persist(id: string, ran?: Environment): Promise<void> {
        const held = this.live.get(id);

        /*
         * `ran` is the environment the caller actually executed against.
         *
         * Without it there is a hole. Two requests can be in flight on one
         * process; if the first loses its write, the environment is dropped —
         * and the second then finds nothing here, concludes there is nothing to
         * write, and answers 200 for a block that went with it. Observed exactly
         * once in fifty against two replicas: a hash handed back with no receipt
         * behind it, which is the failure this whole mechanism exists to stop.
         */
        if (ran && held?.env !== ran) throw new StaleEnvironment(id);
        if (!held) return;
        // Nothing has changed since the last write, so there is nothing to write.
        if (held.persisted === held.env.version) return;

        const version = held.env.version;
        const written = await this.store.save({
            id,
            name: held.name,
            rpcUrl: held.rpcUrl,
            chainId: held.env.chainId,
            forkBlock: "0x" + held.env.forkBlock.toString(16),
            createdAt: held.createdAt,
            updatedAt: Date.now(),
            overlay: held.env.exportOverlay(),
            chain: held.env.exportChain(),
            followsHead: held.env.followsHead,
            revision: held.revision,
        });

        if (!written) {
            // Dropped rather than kept and retried: retrying would write state
            // built on a version that no longer exists, which is the overwrite
            // this is here to prevent.
            this.live.delete(id);
            throw new StaleEnvironment(id);
        }

        held.revision += 1;
        // Only now: a write that lost must not leave the environment looking clean.
        held.persisted = version;
    }

    /**
     * Lets an idle environment go without losing it — it is on disk and wakes on demand.
     *
     * A losing write here is not worth raising. Eviction is housekeeping, the
     * environment is being dropped either way, and the row that won is current.
     */
    async evict(id: string): Promise<void> {
        try {
            await this.persist(id);
        } catch (error) {
            if (!(error instanceof StaleEnvironment)) throw error;
        }
        this.live.delete(id);
    }

    liveCount(): number {
        return this.live.size;
    }
}
