/*
 * Telling whoever bills for this that usage has happened.
 *
 * The console decides who has run out of credit, and it used to find out only
 * when a request came through its own proxy. A socket does not come through the
 * proxy — it goes straight to this engine — so an account could spend past zero
 * over a socket and nothing would ever notice. After each meter flush this posts
 * the environments that spent something, and the console takes it from there.
 *
 * It says which environments, not how much: the numbers are already in the
 * database, and a hook that carried them would be a second copy to disagree.
 */
import { createHmac } from "node:crypto";

import type { Usage } from "./meter.ts";

/** A slow console must not hold the meter up; the next flush will say it again. */
const TIMEOUT_MS = 5_000;

export function usageHook(url: string, key: string): (entries: Usage[]) => void {
    return (entries) => {
        // Only what costs anything. A request answered from the cache moves no
        // balance, and posting about it would be a request per flush for nothing.
        const environments = [ ...new Set(entries
            .filter((entry) => entry.misses + entry.forwarded > 0)
            .map((entry) => entry.envId)) ];
        if (environments.length === 0) return;

        const body = JSON.stringify({ environments, at: Date.now() });
        const signature = createHmac("sha256", key).update(body).digest("hex");
        void fetch(url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-forkstate-signature": `sha256=${signature}`,
            },
            body,
            signal: AbortSignal.timeout(TIMEOUT_MS),
        }).then((response) => {
            if (!response.ok) console.error(`usage hook answered ${response.status}`);
        }).catch((error: unknown) => {
            console.error("could not reach the usage hook:", error instanceof Error ? error.message : error);
        });
    };
}
