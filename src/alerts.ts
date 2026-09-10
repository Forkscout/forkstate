/*
 * Telling somebody when something happens.
 *
 * A fork is usually watched by a person or a CI job, and both would rather be
 * told than asked to keep looking. An alert is a rule on one environment and a
 * URL to post to when the rule matches — the same idea as a subscription, for a
 * client that is not connected.
 *
 * Two things make this correct rather than merely working:
 *
 *   - Alerts fire from blocks that were **written out**, not from blocks that
 *     were merely mined. A replica that loses a write throws its block away, and
 *     a webhook that had already announced it would be reporting a transaction
 *     that never happened — the one failure a webhook must never have.
 *   - Delivery never blocks the transaction that caused it. A slow endpoint is
 *     the receiver's problem; making it the sender's turns one broken webhook
 *     into a slow chain.
 */
import { createHmac, randomUUID } from "node:crypto";

import type { AlertRow, Backend, DeliveryRow } from "./backend.ts";
import type { StoredBlock, StoredTx } from "./chain.ts";
import { logMatches, type LogFilter } from "./logs.ts";
import type { Log } from "./types.ts";

/** How long a receiver has to answer before the attempt is a failure. */
const TIMEOUT_MS = 10_000;

/** Attempts per delivery, including the first. */
const ATTEMPTS = 3;

/**
 * Consecutive failures before an alert is switched off.
 *
 * An endpoint that has been refusing for this long is not coming back on its
 * own, and a fork that keeps calling it is spending its own time on nothing.
 * Switched off rather than deleted: the rule someone wrote is still there, with
 * the reason it stopped beside it.
 */
const GIVE_UP_AFTER = 20;

/** The most matches one delivery carries. A busy block is not a reason to send a novel. */
const MAX_MATCHES = 50;

/** How long a list of alerts is reused before it is read again. */
const CACHE_MS = 5_000;

export interface TransactionCriteria {
    from?: string;
    to?: string;
    /** "failed" is the one people actually want, and the reason this kind exists. */
    status?: "any" | "failed" | "succeeded";
}

export type Criteria = LogFilter | TransactionCriteria | Record<string, never>;

/** An alert as it is described to a caller. The secret is not part of that. */
export interface PublicAlert {
    id: string;
    name: string;
    url: string;
    kind: AlertRow["kind"];
    criteria: Criteria;
    active: boolean;
    createdAt: number;
    lastFiredAt: number | null;
    failures: number;
}

export const publicly = (row: AlertRow): PublicAlert => ({
    id: row.id,
    name: row.name,
    url: row.url,
    kind: row.kind,
    criteria: JSON.parse(row.criteria) as Criteria,
    active: row.active,
    createdAt: row.createdAt,
    lastFiredAt: row.lastFiredAt,
    failures: row.failures,
});

/**
 * Refuses a URL that would make this fork someone's errand boy.
 *
 * A webhook is a request the server makes on the caller's behalf, which is the
 * shape of every SSRF there has ever been. Public addresses only, so an alert
 * cannot be pointed at a metadata service, a database on the same network, or
 * anything else that is only reachable from in here.
 */
export function checkUrl(raw: string): URL {
    /*
     * The escape hatch is the engine's, never the caller's.
     *
     * An engine running on somebody's laptop has every reason to post to a
     * server on that laptop, and no attacker to protect it from. A hosted one
     * has the opposite of both. Read from the environment, so which of the two
     * this is stays a decision of whoever started the process.
     */
    const allowPrivate = process.env.FORKSTATE_ALERTS_ALLOW_LOCAL === "1";

    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`"${raw}" is not a URL.`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("A webhook URL must be http or https.");
    }

    const host = url.hostname.toLowerCase();
    const forbidden = host === "localhost"
        || host.endsWith(".localhost")
        || host.endsWith(".internal")
        || host === "metadata.google.internal"
        || /^\[?::1\]?$/.test(host)
        || /^127\./.test(host)
        || /^10\./.test(host)
        || /^192\.168\./.test(host)
        || /^169\.254\./.test(host)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
        || /^0\./.test(host);
    if (forbidden && !allowPrivate) {
        throw new Error(
            `${url.hostname} is not reachable from outside this engine, so an alert cannot post `
            + "to it. Use a public address.",
        );
    }
    return url;
}

/** What one match looks like in the body a receiver gets. */
type Match =
    | { type: "log"; log: Log }
    | { type: "transaction"; transaction: Record<string, unknown> }
    | { type: "block" };

export class Alerts {
    private readonly backend: Backend;
    /** Read per block otherwise, and most blocks match nothing. */
    private readonly cached = new Map<string, { rows: AlertRow[]; at: number }>();

    constructor(backend: Backend) {
        this.backend = backend;
    }

    async list(envId: string): Promise<PublicAlert[]> {
        return (await this.backend.listAlerts(envId)).map(publicly);
    }

    async deliveries(envId: string, alertId: string, limit = 20): Promise<DeliveryRow[]> {
        // Through the environment, so one testnet cannot read another's history
        // by knowing an id.
        const mine = (await this.backend.listAlerts(envId)).some((row) => row.id === alertId);
        if (!mine) throw new Error(`No alert ${alertId} on this testnet.`);
        return this.backend.listDeliveries(alertId, limit);
    }

    /**
     * Creates an alert and returns it with its secret, once.
     *
     * The secret signs every body this alert sends, so the receiver can tell a
     * real delivery from anybody who found the URL. It is shown here and never
     * again, for the same reason an API token is.
     */
    async create(envId: string, input: {
        name: string;
        url: string;
        kind: AlertRow["kind"];
        criteria?: Criteria;
    }): Promise<PublicAlert & { secret: string }> {
        const name = input.name.trim();
        if (!name) throw new Error("An alert needs a name.");
        if (input.kind !== "logs" && input.kind !== "transactions" && input.kind !== "blocks") {
            throw new Error(`"${input.kind}" is not a kind of alert. Use logs, transactions or blocks.`);
        }
        checkUrl(input.url);

        const existing = await this.backend.listAlerts(envId);
        if (existing.length >= 25) {
            throw new Error("A testnet may have 25 alerts. Delete one first.");
        }

        const row: AlertRow = {
            id: randomUUID().slice(0, 8),
            envId,
            name,
            url: input.url,
            secret: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
            kind: input.kind,
            criteria: JSON.stringify(input.criteria ?? {}),
            active: true,
            createdAt: Date.now(),
            lastFiredAt: null,
            failures: 0,
        };
        await this.backend.saveAlert(row);
        this.cached.delete(envId);
        return { ...publicly(row), secret: row.secret };
    }

    async setActive(envId: string, id: string, active: boolean): Promise<PublicAlert> {
        const row = (await this.backend.listAlerts(envId)).find((one) => one.id === id);
        if (!row) throw new Error(`No alert ${id} on this testnet.`);
        // Turning one back on clears the count that turned it off, or it switches
        // itself off again on the next failure.
        const next: AlertRow = { ...row, active, failures: active ? 0 : row.failures };
        await this.backend.saveAlert(next);
        this.cached.delete(envId);
        return publicly(next);
    }

    async delete(envId: string, id: string): Promise<boolean> {
        const gone = await this.backend.deleteAlert(envId, id);
        this.cached.delete(envId);
        return gone;
    }

    async deleteAll(envId: string): Promise<void> {
        await this.backend.deleteAlerts(envId);
        this.cached.delete(envId);
    }

    /** Sends one delivery now, so somebody setting an alert up can see it arrive. */
    async test(envId: string, id: string): Promise<DeliveryRow> {
        const row = (await this.backend.listAlerts(envId)).find((one) => one.id === id);
        if (!row) throw new Error(`No alert ${id} on this testnet.`);
        return this.post(row, {
            alert: { id: row.id, name: row.name },
            environment: envId,
            test: true,
            matches: [],
        }, 0);
    }

    private async rowsFor(envId: string): Promise<AlertRow[]> {
        const held = this.cached.get(envId);
        if (held && Date.now() - held.at < CACHE_MS) return held.rows;
        const rows = await this.backend.listAlerts(envId);
        this.cached.set(envId, { rows, at: Date.now() });
        return rows;
    }

    /**
     * Announces a block that has been written out.
     *
     * Deliberately not awaited by its caller. A receiver that takes ten seconds
     * must not make the transaction take ten seconds, and there is nothing the
     * caller could do about a failure anyway — it is recorded where the person
     * who set the alert up can see it.
     */
    dispatch(envId: string, chainId: number, block: StoredBlock, txs: StoredTx[]): void {
        void (async () => {
            let rows: AlertRow[];
            try {
                rows = await this.rowsFor(envId);
            } catch (error) {
                console.error(`could not read alerts for ${envId}:`, error);
                return;
            }

            for (const row of rows) {
                if (!row.active) continue;
                const matches = this.matchesFor(row, txs);
                if (matches.length === 0) continue;
                await this.post(row, {
                    alert: { id: row.id, name: row.name },
                    environment: envId,
                    chainId,
                    block: {
                        number: "0x" + block.number.toString(16),
                        hash: block.hash,
                        timestamp: "0x" + block.timestamp.toString(16),
                    },
                    matches: matches.slice(0, MAX_MATCHES),
                    truncated: matches.length > MAX_MATCHES,
                }, matches.length);
            }
        })();
    }

    private matchesFor(row: AlertRow, txs: StoredTx[]): Match[] {
        let criteria: Criteria;
        try {
            criteria = JSON.parse(row.criteria) as Criteria;
        } catch {
            // A rule nobody can read matches nothing, which is safer than
            // matching everything.
            return [];
        }

        if (row.kind === "blocks") return [ { type: "block" } ];

        if (row.kind === "logs") {
            const filter = criteria as LogFilter;
            return txs.flatMap((tx) => tx.logs
                .filter((log) => logMatches(log, filter))
                .map((log): Match => ({ type: "log", log })));
        }

        const wanted = criteria as TransactionCriteria;
        const same = (a: string | null | undefined, b: string | undefined) =>
            !b || (a ?? "").toLowerCase() === b.toLowerCase();

        return txs
            .filter((tx) => {
                if (!same(tx.from, wanted.from)) return false;
                if (!same(tx.to, wanted.to)) return false;
                if (wanted.status === "failed" && tx.status !== 0) return false;
                if (wanted.status === "succeeded" && tx.status !== 1) return false;
                return true;
            })
            .map((tx): Match => ({
                type: "transaction",
                transaction: {
                    hash: tx.hash,
                    from: tx.from,
                    to: tx.to,
                    value: tx.value,
                    gasUsed: tx.gasUsed,
                    status: tx.status === 1 ? "success" : "reverted",
                    // The decoded one. A receiver holding a pager wants a
                    // sentence, not four bytes to go and look up.
                    revertReason: tx.error ?? undefined,
                    contractAddress: tx.contractAddress ?? undefined,
                },
            }));
    }

    /** Posts, retries, and writes down what happened either way. */
    private async post(row: AlertRow, payload: unknown, matches: number): Promise<DeliveryRow> {
        const body = JSON.stringify({ ...payload as object, sentAt: new Date().toISOString() });
        const signature = createHmac("sha256", row.secret).update(body).digest("hex");

        let status: number | null = null;
        let error: string | null = null;
        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
            try {
                const response = await fetch(row.url, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        "user-agent": "forkstate-alerts/1",
                        // Named the way every webhook does it, so a receiver can
                        // verify without reading anything of ours.
                        "x-forkstate-signature": `sha256=${signature}`,
                        "x-forkstate-alert": row.id,
                    },
                    body,
                    signal: AbortSignal.timeout(TIMEOUT_MS),
                });
                status = response.status;
                if (response.ok) { error = null; break; }
                error = `the endpoint answered ${response.status}`;
            } catch (cause) {
                status = null;
                error = cause instanceof Error ? cause.message : String(cause);
            }
            // 1s, then 4s. Long enough to outlast a restart, short enough that a
            // block's worth of alerts does not pile up behind it.
            if (attempt < ATTEMPTS - 1) {
                await new Promise((done) => setTimeout(done, 1000 * (attempt + 1) ** 2));
            }
        }

        const delivery: DeliveryRow = {
            id: randomUUID().slice(0, 12),
            alertId: row.id,
            at: Date.now(),
            ok: error === null,
            status,
            error,
            matches,
        };

        try {
            await this.backend.recordDelivery(delivery);
            const failures = delivery.ok ? 0 : row.failures + 1;
            await this.backend.saveAlert({
                ...row,
                lastFiredAt: delivery.at,
                failures,
                active: row.active && failures < GIVE_UP_AFTER,
            });
            this.cached.delete(row.envId);
        } catch (cause) {
            console.error(`could not record a delivery for alert ${row.id}:`, cause);
        }
        return delivery;
    }
}
