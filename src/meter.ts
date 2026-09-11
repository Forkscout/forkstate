/*
 * What each environment actually costs.
 *
 * Requests are the obvious thing to count and almost the wrong one. A warm call
 * is answered from the shared cache in single-digit milliseconds and costs
 * nothing anybody bills for; a cold one waits four hundred to eight hundred on
 * the parent chain, and that is a paid request to whoever provides it. Ten
 * thousand warm calls are cheaper than a hundred cold ones.
 *
 * So both are counted, and the one that matters is the miss.
 *
 * Held in memory and flushed in batches. The whole point of the cache is to stop
 * paying for round trips, and a meter that wrote a row per miss would spend more
 * of them than it measured.
 */

export interface Usage {
    envId: string;
    /** UTC, `YYYY-MM-DD`. A day is the smallest unit anyone bills on. */
    day: string;
    requests: number;
    /** Reads that fell through to the parent chain. The number that costs money. */
    misses: number;
    /**
     * Calls handed to the parent chain whole — a block from before the fork, an
     * old receipt, a method this engine does not implement.
     *
     * Kept apart from misses because they are a different thing to the person
     * paying: a miss is state their code needed, a forwarded call is history
     * their tools asked about. Both are a paid request upstream.
     */
    forwarded: number;
}

export interface UsageSink {
    addUsage(entries: Usage[]): Promise<void>;
}

const today = (at = Date.now()): string => new Date(at).toISOString().slice(0, 10);

export class Meter {
    private readonly sink: UsageSink | null;
    private readonly pending = new Map<string, Usage>();
    private timer: ReturnType<typeof setInterval> | null = null;
    /**
     * Told what was just written, after it was written.
     *
     * For whatever needs to act on spend as it happens — the console stopping an
     * account that has run out — without polling the database to find out.
     */
    onFlushed: ((entries: Usage[]) => void) | null = null;
    /** Set while a flush is in flight, so two never overlap. */
    private flushing: Promise<void> | null = null;

    constructor(sink: UsageSink | null, everyMs = 30_000) {
        this.sink = sink;
        if (sink && everyMs > 0) {
            this.timer = setInterval(() => void this.flush(), everyMs);
            this.timer.unref?.();
        }
    }

    /** One request against an environment. A batch is worth its number of calls. */
    request(envId: string, calls = 1, at = Date.now()): void {
        this.entry(envId, at).requests += calls;
    }

    /** One read that had to be fetched from the parent chain. */
    miss(envId: string, at = Date.now()): void {
        this.entry(envId, at).misses += 1;
    }

    /** One call passed to the parent chain as it was. */
    forward(envId: string, at = Date.now()): void {
        this.entry(envId, at).forwarded += 1;
    }

    private entry(envId: string, at: number): Usage {
        const day = today(at);
        const key = `${envId}|${day}`;
        let found = this.pending.get(key);
        if (!found) {
            found = { envId, day, requests: 0, misses: 0, forwarded: 0 };
            this.pending.set(key, found);
        }
        return found;
    }

    /** What has not been written out yet, for a caller that wants the live number. */
    unflushed(envId: string): { requests: number; misses: number; forwarded: number } {
        let requests = 0;
        let misses = 0;
        let forwarded = 0;
        for (const entry of this.pending.values()) {
            if (entry.envId !== envId) continue;
            requests += entry.requests;
            misses += entry.misses;
            forwarded += entry.forwarded;
        }
        return { requests, misses, forwarded };
    }

    async flush(): Promise<void> {
        if (this.flushing) return this.flushing;
        if (!this.sink || this.pending.size === 0) return;

        const batch = [ ...this.pending.values() ];
        this.pending.clear();

        this.flushing = (async () => {
            try {
                await this.sink!.addUsage(batch);
                try {
                    this.onFlushed?.(batch);
                } catch (error) {
                    console.error("a usage listener threw:", error);
                }
            } catch (error) {
                // Put it back rather than lose it: usage that vanishes because the
                // database blinked is usage somebody is not billed for.
                for (const entry of batch) {
                    const held = this.entry(entry.envId, Date.parse(entry.day + "T00:00:00Z"));
                    held.requests += entry.requests;
                    held.misses += entry.misses;
                    held.forwarded += entry.forwarded;
                }
                console.error("could not write usage:", error);
            } finally {
                this.flushing = null;
            }
        })();
        return this.flushing;
    }

    async close(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        await this.flush();
    }
}
