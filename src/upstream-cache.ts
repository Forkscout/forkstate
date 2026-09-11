/**
 * One cache of the parent chain, shared by every environment.
 *
 * Mainnet state at a given block is the same for everybody. A hundred people
 * forking the same token contract should fetch its code once, not a hundred
 * times — and on a metered RPC that difference is the whole bill.
 *
 * Keyed by block as well as address: two environments forked at different heights
 * are asking different questions, and answering one with the other's data would
 * be wrong in a way nothing downstream could detect.
 */
import { reportError } from "./report.ts";
import type { Backend } from "./backend.ts";

export interface CacheStats {
    hits: number;
    misses: number;
    writes: number;
    entries: number;
    /** Upstream calls avoided, which is what this is for. */
    saved: number;
}

/** How many pending writes to let pile up before flushing them together. */
const FLUSH_AT = 64;
const FLUSH_AFTER_MS = 250;

export class UpstreamCache {
    private readonly backend: Backend | null;
    private readonly memory = new Map<string, string>();
    private readonly maxMemory: number;

    /*
     * Writes are buffered rather than sent as they happen.
     *
     * A cold call misses dozens of keys, and against Postgres a round trip each
     * would cost more than the upstream reads the cache exists to avoid. They are
     * already in memory by then, so nothing waits on the flush.
     */
    private pending = new Map<string, string>();
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private flushing: Promise<void> | null = null;

    private hits = 0;
    private misses = 0;
    private writes = 0;

    constructor(backend: Backend | null, maxMemory = 200_000) {
        this.backend = backend;
        this.maxMemory = maxMemory;
    }

    static key(chain: string, block: string, kind: string, address: string, slot?: string): string {
        return `${chain}|${block}|${kind}|${address.toLowerCase()}${slot ? "|" + slot.toLowerCase() : ""}`;
    }

    async get(key: string): Promise<string | null> {
        const hot = this.memory.get(key) ?? this.pending.get(key);
        if (hot !== undefined) {
            this.hits++;
            return hot;
        }

        if (this.backend) {
            const stored = await this.backend.cacheGet(key);
            if (stored !== null) {
                this.hits++;
                this.remember(key, stored);
                return stored;
            }
        }

        this.misses++;
        return null;
    }

    set(key: string, value: string): void {
        this.writes++;
        this.remember(key, value);
        if (!this.backend) return;

        this.pending.set(key, value);
        if (this.pending.size >= FLUSH_AT) {
            void this.flush();
            return;
        }
        this.flushTimer ??= setTimeout(() => void this.flush(), FLUSH_AFTER_MS);
        this.flushTimer.unref?.();
    }

    /** Sends everything buffered. Safe to call at any time, including on exit. */
    async flush(): Promise<void> {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (!this.backend || this.pending.size === 0) return;

        // Serialised: two overlapping flushes would send the same rows twice.
        this.flushing = (this.flushing ?? Promise.resolve()).then(async () => {
            const batch = [ ...this.pending.entries() ];
            this.pending = new Map();
            try {
                await this.backend!.cachePut(batch);
            } catch (error) {
                // A cache that cannot write is slower, not broken — every value
                // is still in memory and the next read falls through upstream.
                reportError("cache flush:", error instanceof Error ? error.message : error);
            }
        });
        await this.flushing;
    }

    /**
     * Holds an entry hot, dropping the oldest when full.
     *
     * A Map keeps insertion order, so the first key it yields is the least
     * recently added — enough of an eviction policy for a cache whose entries are
     * all equally valid forever.
     */
    private remember(key: string, value: string): void {
        if (this.memory.size >= this.maxMemory) {
            const oldest = this.memory.keys().next().value;
            if (oldest !== undefined) this.memory.delete(oldest);
        }
        this.memory.set(key, value);
    }

    async stats(): Promise<CacheStats> {
        const entries = this.backend ? await this.backend.cacheCount() : this.memory.size;
        return { hits: this.hits, misses: this.misses, writes: this.writes, entries, saved: this.hits };
    }
}
