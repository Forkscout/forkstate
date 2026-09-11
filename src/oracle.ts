/**
 * Pretending a price feed says something.
 *
 * Protocols read prices from Chainlink feeds, and the question worth testing
 * is always "what happens when the price is X" — a liquidation, a depeg, a
 * crash. The feed's own storage is the aggregator's business and differs
 * between versions, so the value is not written into it. Instead the feed's
 * code is swapped for a few hundred bytes that answer the price questions
 * with the chosen value and hand every other call — `decimals()`,
 * `description()`, `aggregator()` — to a copy of the original code, with
 * DELEGATECALL, so it runs against the feed's own storage exactly as before.
 *
 * `updatedAt` is the block's own time, read with TIMESTAMP when asked, so a
 * consumer's staleness check never trips because time moved on after the
 * override. The round id is one past the real latest, so a consumer that
 * insists on a new round sees one.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@ethereumjs/util";

import type { Environment } from "./environment.ts";
import { normaliseAddress } from "./overlay.ts";

/** Trailing bytes after the code, never executed, that mark a feed as overridden. */
const MARK = bytesToHex(utf8ToBytes("forkstate-oracle")).slice(2);

const SELECTORS = {
    latestRoundData: "feaf968c",
    getRoundData: "9a6fc8f5",
    latestAnswer: "50d25bcd",
    latestTimestamp: "8205bf6a",
    latestRound: "668a0f02",
    decimals: "313ce567",
};

const WORD = (1n << 256n) - 1n;
/** A number as one EVM word, two's complement for a negative answer. */
const word = (value: bigint) => (value & WORD).toString(16).padStart(64, "0");

export type Part = string | { label: string } | { jump: string };

/**
 * Hex opcodes, labels and jumps to labels, as bytecode.
 *
 * Two passes: every jump is a PUSH2, so where each label lands is known before
 * any address is written.
 */
export function assemble(parts: Part[]): string {
    const at = new Map<string, number>();
    let offset = 0;
    for (const part of parts) {
        if (typeof part === "string") offset += part.length / 2;
        else if ("label" in part) { at.set(part.label, offset); offset += 1; }
        else offset += 3;
    }
    return parts.map((part) => {
        if (typeof part === "string") return part;
        if ("label" in part) return "5b"; // JUMPDEST
        const target = at.get(part.jump);
        if (target === undefined) throw new Error(`no label ${part.jump}`);
        return "61" + target.toString(16).padStart(4, "0"); // PUSH2
    }).join("");
}

/** The replacement code: the price questions answered, everything else delegated. */
export function oracleCode(options: { answer: bigint; roundId: bigint; shadow: string }): string {
    const answer = word(options.answer);
    const round = word(options.roundId);
    const branch = (selector: string, label: string): Part[] => [ "80", "63" + selector, "14", { jump: label }, "57" ];
    const returnWord = (value: string): Part[] => [ value, "600052", "60206000f3" ];

    return "0x" + assemble([
        "600035", "60e01c", // selector = calldata[0:4]
        ...branch(SELECTORS.latestRoundData, "round"),
        ...branch(SELECTORS.getRoundData, "get"),
        ...branch(SELECTORS.latestAnswer, "answer"),
        ...branch(SELECTORS.latestTimestamp, "time"),
        ...branch(SELECTORS.latestRound, "id"),

        // Anything else: the original code, against this address's storage.
        { label: "delegate" },
        "36", "6000", "6000", "37",                              // CALLDATACOPY(0, 0, size)
        "6000", "6000", "36", "6000", "73" + normaliseAddress(options.shadow).slice(2), "5a", "f4",
        "3d", "6000", "6000", "3e",                              // RETURNDATACOPY(0, 0, size)
        { jump: "ok" }, "57",
        "3d", "6000", "fd",                                      // REVERT with what it said
        { label: "ok" }, "3d", "6000", "f3",

        // (roundId, answer, startedAt, updatedAt, answeredInRound)
        { label: "round" },
        "7f" + round, "600052",
        "7f" + answer, "602052",
        "42", "604052",
        "42", "606052",
        "7f" + round, "608052",
        "60a06000f3",

        // The overridden round by id; any other round is the real feed's.
        { label: "get" },
        "600435", "7f" + round, "14", { jump: "round" }, "57", { jump: "delegate" }, "56",

        { label: "answer" }, ...returnWord("7f" + answer),
        { label: "time" }, ...returnWord("42"),
        { label: "id" }, ...returnWord("7f" + round),

        "00", MARK,
    ]);
}

/** Where the feed's original code is kept while it is overridden. One per feed, never a real account. */
export function shadowOf(feed: string): string {
    const hash = bytesToHex(keccak_256(utf8ToBytes(`forkstate:oracle:${normaliseAddress(feed)}`)));
    return "0x" + hash.slice(-40);
}

async function ask(env: Environment, feed: string, selector: string, what: string): Promise<string> {
    const result = await env.call({ to: feed, data: "0x" + selector });
    if (result.reverted || !result.returnValue || result.returnValue === "0x") {
        throw new Error(`${feed} does not answer ${what}, so it is not a Chainlink-style price feed.`);
    }
    return result.returnValue;
}

/** A price in the feed's units ("2500.5"), or 0x hex for the raw answer. */
function answerFrom(price: unknown, decimals: number): bigint {
    const text = String(price ?? "").trim();
    if (/^-?0x[0-9a-fA-F]+$/.test(text)) {
        return text.startsWith("-") ? -BigInt(text.slice(1)) : BigInt(text);
    }
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match) throw new Error(`"${text}" is not a price. Send it like "2500.5", or as 0x hex for the raw answer.`);
    const fraction = match[3] ?? "";
    if (fraction.length > decimals) throw new Error(`This feed has ${decimals} decimals; "${text}" has more.`);
    const value = BigInt(match[2]! + fraction.padEnd(decimals, "0"));
    return match[1] ? -value : value;
}

export async function isOverridden(env: Environment, feed: string): Promise<boolean> {
    return (await env.getCode(normaliseAddress(feed))).endsWith(MARK);
}

export async function setPrice(env: Environment, feedInput: string, price: unknown) {
    const feed = normaliseAddress(feedInput);
    const code = await env.getCode(feed);
    if (code === "0x") throw new Error(`There is no contract at ${feed} on this fork.`);

    const overridden = code.endsWith(MARK);
    const shadow = shadowOf(feed);
    // Once, the first time: overriding twice must not save the override as
    // the "original".
    if (!overridden) await env.setCode(shadow, code);

    // Both through the feed as it stands, which reaches the real code either way.
    const decimals = Number(BigInt(await ask(env, feed, SELECTORS.decimals, "decimals()")));
    const latest = await ask(env, feed, SELECTORS.latestRoundData, "latestRoundData()");
    const current = BigInt("0x" + latest.slice(2, 66));
    const roundId = overridden ? current : current + 1n;

    const answer = answerFrom(price, decimals);
    await env.setCode(feed, oracleCode({ answer, roundId, shadow }));
    return { feed, answer: answer.toString(), decimals, roundId: "0x" + roundId.toString(16) };
}

/** Puts the feed's own code back. False if it was not overridden. */
export async function resetPrice(env: Environment, feedInput: string): Promise<boolean> {
    const feed = normaliseAddress(feedInput);
    if (!(await isOverridden(env, feed))) return false;
    await env.setCode(feed, await env.getCode(shadowOf(feed)));
    return true;
}
