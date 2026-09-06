/*
 * How much one environment may ask for.
 *
 * The engine holds every testnet in one process, so an unbounded caller is not
 * merely rude to itself: a CI job in a loop starves every other testnet on the
 * node, and each miss it causes is a paid request to the parent chain. A limit
 * per environment keeps one tenant's mistake inside that tenant.
 *
 * A token bucket rather than a fixed window, because the traffic that matters is
 * bursty — a page load fires a dozen calls at once and then nothing for a minute,
 * and a fixed window either refuses that burst or allows a sustained flood.
 *
 * In memory, deliberately. The engine is one long-lived process, so the count is
 * exact and costs nothing; a shared store would add a round trip to every request
 * to limit the round trips.
 */

export interface Limits {
    /** Sustained requests per second, once the burst is spent. */
    perSecond: number;
    /** How many may arrive at once before that rate applies. */
    burst: number;
}

export const NO_LIMIT: Limits = { perSecond: Infinity, burst: Infinity };

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): Limits {
    const perSecond = Number(env.FORKSTATE_RATE ?? 0);
    if (!Number.isFinite(perSecond) || perSecond <= 0) return NO_LIMIT;
    const burst = Number(env.FORKSTATE_BURST ?? 0);
    return {
        perSecond,
        // A burst that cannot hold a second's worth of tokens would refuse
        // traffic that is inside the rate it is meant to allow.
        burst: Number.isFinite(burst) && burst > 0 ? Math.max(burst, perSecond) : perSecond * 5,
    };
}

interface Bucket {
    tokens: number;
    /** When `tokens` was last correct, so refilling is arithmetic, not a timer. */
    at: number;
}

export class RateLimiter {
    private readonly limits: Limits;
    private readonly buckets = new Map<string, Bucket>();

    constructor(limits: Limits) {
        this.limits = limits;
    }

    get unlimited(): boolean {
        return this.limits.perSecond === Infinity;
    }

    /**
     * Takes `cost` tokens for a key, or says how long until they exist.
     *
     * The cost is the number of calls in the request: a batch of fifty is fifty
     * calls' worth of work, and charging it as one would make batching a way
     * around the limit rather than a way to be efficient.
     */
    take(key: string, cost = 1, now = Date.now()): { ok: true } | { ok: false; retryAfter: number } {
        if (this.unlimited) return { ok: true };

        const bucket = this.buckets.get(key) ?? { tokens: this.limits.burst, at: now };
        const refilled = Math.min(
            this.limits.burst,
            bucket.tokens + ((now - bucket.at) / 1000) * this.limits.perSecond,
        );

        if (refilled < cost) {
            // Not spent: a refused request should not push the caller further
            // behind, or a client that retries hard can never recover.
            this.buckets.set(key, { tokens: refilled, at: now });
            return { ok: false, retryAfter: Math.ceil(((cost - refilled) / this.limits.perSecond) * 1000) };
        }

        this.buckets.set(key, { tokens: refilled - cost, at: now });
        return { ok: true };
    }

    /** Lets an environment's bucket go when the environment does. */
    forget(key: string): void {
        this.buckets.delete(key);
    }

    /**
     * Drops buckets that have refilled completely.
     *
     * A full bucket is indistinguishable from one that has never been used, so
     * keeping it only holds memory for a caller that has gone away.
     */
    sweep(now = Date.now()): void {
        if (this.unlimited) return;
        const full = (this.limits.burst / this.limits.perSecond) * 1000;
        for (const [ key, bucket ] of this.buckets) {
            if (now - bucket.at >= full) this.buckets.delete(key);
        }
    }
}
