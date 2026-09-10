/*
 * Matching a log against a filter.
 *
 * Its own module because two places ask the question — `eth_getLogs`, which
 * looks backwards, and `eth_subscribe`, which looks forwards — and an indexer
 * that backfills with one and then follows with the other has every right to
 * expect the same answer from both.
 */
import type { Log } from "./types.ts";

export interface LogFilter {
    address?: string | string[];
    /**
     * Positional, and each position may be a single topic, `null` for "anything",
     * or a list of alternatives. The list form is how a caller asks for Transfer
     * *or* Approval in one subscription, and dropping it silently — treating the
     * array as a topic that can never match — is a filter that returns nothing
     * and looks like a chain with no activity.
     */
    topics?: Array<string | string[] | null>;
}

const lower = (value: string) => value.toLowerCase();

/** True when this log is one the filter asked for. */
export function logMatches(log: Log, filter: LogFilter): boolean {
    if (filter.address) {
        const wanted = Array.isArray(filter.address) ? filter.address : [ filter.address ];
        if (!wanted.some((address) => lower(address) === lower(log.address))) return false;
    }

    for (const [ position, wanted ] of (filter.topics ?? []).entries()) {
        // `null` and a missing entry both mean "anything here".
        if (wanted === null || wanted === undefined) continue;
        const actual = log.topics[position];
        if (actual === undefined) return false;
        const options = Array.isArray(wanted) ? wanted : [ wanted ];
        // An empty list is the same as null: nothing was ruled out.
        if (options.length === 0) continue;
        if (!options.some((topic) => lower(topic) === lower(actual))) return false;
    }

    return true;
}
