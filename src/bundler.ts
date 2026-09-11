/**
 * An ERC-4337 bundler inside the fork.
 *
 * Account-abstraction wallets do not send transactions: they send user
 * operations to a bundler, which wraps them in a call to the EntryPoint. A
 * fork without one cannot be used by a smart-account app at all — so this is
 * that bundler, speaking the standard methods (ERC-7769) against the real
 * EntryPoint contracts, which are already deployed on the parent chain.
 *
 * Each operation is its own bundle: simulated first, so a failing operation is
 * refused with the EntryPoint's reason instead of mined as a reverted
 * transaction, then sent from a fixed bundler address. Nothing is kept on the
 * side. A receipt is found again from the EntryPoint's own UserOperationEvent,
 * and an operation from the calldata of the transaction that carried it — so
 * both survive a restart, a clone and a snapshot like everything else.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@ethereumjs/util";

import type { StoredTx } from "./chain.ts";
import type { Environment } from "./environment.ts";
import { normaliseAddress } from "./overlay.ts";

type Version = "0.6" | "0.7" | "0.8";

/** The canonical deployments, newest first — the order eth_supportedEntryPoints reports. */
export const ENTRY_POINTS: Array<{ version: Version; address: string }> = [
    { version: "0.8", address: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108" },
    { version: "0.7", address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" },
    { version: "0.6", address: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789" },
];

/** Sends every bundle, and is paid what the operations pay. Recognisable in an explorer. */
export const BUNDLER = "0x4337000000000000000000000000000000004337";

const topic = (signature: string) => bytesToHex(keccak_256(utf8ToBytes(signature)));
const USER_OPERATION_EVENT = topic("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");
const REVERT_REASON_EVENT = topic("UserOperationRevertReason(bytes32,address,uint256,bytes)");
const BEFORE_EXECUTION = topic("BeforeExecution()");

const SELECTOR = {
    handleOps: { "0.6": "1fad948c", "0.7": "765e827f", "0.8": "765e827f" },
    failedOp: "220266b6",
    failedOpWithRevert: "65c8fd4d",
    errorString: "08c379a0",
};

/**
 * A refusal in the shape ERC-7769 gives it: a code a client can branch on, and
 * the EntryPoint's own reason ("AA24 signature error") as the message.
 */
export class UserOpError extends Error {
    readonly code: number;

    constructor(message: string, code: number) {
        super(message);
        this.code = code;
    }
}

export type UserOperation = Record<string, unknown>;

function versionOf(entryPoint: unknown): { version: Version; address: string } {
    const wanted = typeof entryPoint === "string" ? entryPoint.toLowerCase() : "";
    const found = ENTRY_POINTS.find((e) => e.address.toLowerCase() === wanted);
    if (!found) {
        throw new UserOpError(
            `Unsupported entry point ${String(entryPoint)}. Supported: ${ENTRY_POINTS.map((e) => `${e.address} (v${e.version})`).join(", ")}.`,
            -32602,
        );
    }
    return found;
}

// ---- ABI, just enough of it ----------------------------------------------------

type Member = { word: string } | { bytes: string };

const strip = (hex: string) => hex.replace(/^0x/, "").toLowerCase();
const pad = (hex: string) => strip(hex).padStart(64, "0");
const uint = (value: bigint) => value.toString(16).padStart(64, "0");
const u128 = (value: bigint) => value.toString(16).padStart(32, "0");
const padRight = (hex: string) => hex + "0".repeat((64 - (hex.length % 64)) % 64);

/** A tuple with dynamic members: the heads, then each `bytes` in the tail. */
function encodeTuple(members: Member[]): string {
    let head = "";
    let tail = "";
    const headSize = members.length * 32;
    for (const member of members) {
        if ("word" in member) {
            head += member.word;
        } else {
            head += uint(BigInt(headSize + tail.length / 2));
            const data = strip(member.bytes);
            tail += uint(BigInt(data.length / 2)) + padRight(data);
        }
    }
    return head + tail;
}

function readWord(hex: string, at: number): bigint {
    return BigInt("0x" + (hex.slice(at * 2, at * 2 + 64) || "0"));
}

function readBytes(hex: string, at: number): string {
    const length = Number(readWord(hex, at));
    return "0x" + hex.slice((at + 32) * 2, (at + 32 + length) * 2);
}

// ---- operations ------------------------------------------------------------------

function hexField(op: UserOperation, name: string, fallback?: string): string {
    const value = op[name] ?? fallback;
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) {
        throw new UserOpError(`userOp.${name} must be 0x-prefixed hex.`, -32602);
    }
    return value;
}

const quantity = (op: UserOperation, name: string, fallback = "0x0") => BigInt(hexField(op, name, fallback) === "0x" ? "0x0" : hexField(op, name, fallback));
const address = (op: UserOperation, name: string) => {
    const value = hexField(op, name);
    if (strip(value).length !== 40) throw new UserOpError(`userOp.${name} must be an address.`, -32602);
    return value;
};

/** initCode, from `factory` + `factoryData` (v0.7 form) or as given (v0.6 form). */
function initCodeOf(op: UserOperation): string {
    if (typeof op.factory === "string" && op.factory !== "0x" && !/^0x0{40}$/i.test(op.factory)) {
        return "0x" + strip(address(op, "factory")) + strip(hexField(op, "factoryData", "0x"));
    }
    return hexField(op, "initCode", "0x");
}

function paymasterAndDataOf(op: UserOperation): string {
    if (typeof op.paymaster === "string" && op.paymaster !== "0x" && !/^0x0{40}$/i.test(op.paymaster)) {
        return "0x" + strip(address(op, "paymaster"))
            + u128(quantity(op, "paymasterVerificationGasLimit"))
            + u128(quantity(op, "paymasterPostOpGasLimit"))
            + strip(hexField(op, "paymasterData", "0x"));
    }
    return hexField(op, "paymasterAndData", "0x");
}

/** The operation as the EntryPoint's struct, for its version. */
function members(version: Version, op: UserOperation): Member[] {
    const sender = { word: pad(address(op, "sender")) };
    const nonce = { word: uint(quantity(op, "nonce")) };
    const callData = { bytes: hexField(op, "callData", "0x") };
    const signature = { bytes: hexField(op, "signature", "0x") };
    if (version === "0.6") {
        return [
            sender, nonce, { bytes: initCodeOf(op) }, callData,
            { word: uint(quantity(op, "callGasLimit")) },
            { word: uint(quantity(op, "verificationGasLimit")) },
            { word: uint(quantity(op, "preVerificationGas")) },
            { word: uint(quantity(op, "maxFeePerGas")) },
            { word: uint(quantity(op, "maxPriorityFeePerGas")) },
            { bytes: paymasterAndDataOf(op) },
            signature,
        ];
    }
    return [
        sender, nonce, { bytes: initCodeOf(op) }, callData,
        { word: u128(quantity(op, "verificationGasLimit")) + u128(quantity(op, "callGasLimit")) },
        { word: uint(quantity(op, "preVerificationGas")) },
        { word: u128(quantity(op, "maxPriorityFeePerGas")) + u128(quantity(op, "maxFeePerGas")) },
        { bytes: paymasterAndDataOf(op) },
        signature,
    ];
}

/** `handleOps([op], beneficiary)`. */
function handleOpsData(version: Version, op: UserOperation): string {
    const tuple = encodeTuple(members(version, op));
    return "0x" + SELECTOR.handleOps[version]
        + uint(0x40n) + pad(BUNDLER)             // (ops offset, beneficiary)
        + uint(1n) + uint(0x20n) + tuple;       // one element, at the start of the element area
}

/** Reads the operations back out of a handleOps call, in the client's (unpacked) form. */
function decodeOps(version: Version, input: string): UserOperation[] {
    const hex = strip(input).slice(8);
    const start = Number(readWord(hex, 0));
    const count = Number(readWord(hex, start));
    const out: UserOperation[] = [];
    const quantityOf = (value: bigint) => "0x" + value.toString(16);
    for (let i = 0; i < count; i++) {
        const at = start + 32 + Number(readWord(hex, start + 32 + i * 32));
        const w = (j: number) => readWord(hex, at + j * 32);
        const b = (j: number) => readBytes(hex, at + Number(w(j)));
        const addressAt = (j: number) => "0x" + w(j).toString(16).padStart(40, "0");
        if (version === "0.6") {
            out.push({
                sender: addressAt(0), nonce: quantityOf(w(1)), initCode: b(2), callData: b(3),
                callGasLimit: quantityOf(w(4)), verificationGasLimit: quantityOf(w(5)),
                preVerificationGas: quantityOf(w(6)), maxFeePerGas: quantityOf(w(7)),
                maxPriorityFeePerGas: quantityOf(w(8)), paymasterAndData: b(9), signature: b(10),
            });
            continue;
        }
        const high = (value: bigint) => quantityOf(value >> 128n);
        const low = (value: bigint) => quantityOf(value & ((1n << 128n) - 1n));
        const initCode = strip(b(2));
        const paymasterAndData = strip(b(7));
        out.push({
            sender: addressAt(0),
            nonce: quantityOf(w(1)),
            ...(initCode ? { factory: "0x" + initCode.slice(0, 40), factoryData: "0x" + initCode.slice(40) } : {}),
            callData: b(3),
            verificationGasLimit: high(w(4)),
            callGasLimit: low(w(4)),
            preVerificationGas: quantityOf(w(5)),
            maxPriorityFeePerGas: high(w(6)),
            maxFeePerGas: low(w(6)),
            ...(paymasterAndData ? {
                paymaster: "0x" + paymasterAndData.slice(0, 40),
                paymasterVerificationGasLimit: quantityOf(BigInt("0x" + (paymasterAndData.slice(40, 72) || "0"))),
                paymasterPostOpGasLimit: quantityOf(BigInt("0x" + (paymasterAndData.slice(72, 104) || "0"))),
                paymasterData: "0x" + paymasterAndData.slice(104),
            } : {}),
            signature: b(8),
        });
    }
    return out;
}

/** The EntryPoint's revert, as the refusal a bundler would give. */
function refusal(returnValue: string | undefined, fallback: string): UserOpError {
    const hex = strip(returnValue ?? "");
    const selector = hex.slice(0, 8);
    const body = hex.slice(8);
    let reason = fallback;
    if (selector === SELECTOR.failedOp || selector === SELECTOR.failedOpWithRevert) {
        const text = readBytes(body, Number(readWord(body, 32)));
        reason = Buffer.from(strip(text), "hex").toString("utf8");
        if (selector === SELECTOR.failedOpWithRevert) {
            const inner = readBytes(body, Number(readWord(body, 64)));
            if (strip(inner)) reason += ` (the call reverted with ${inner})`;
        }
    } else if (selector === SELECTOR.errorString) {
        reason = Buffer.from(strip(readBytes(body, Number(readWord(body, 0)))), "hex").toString("utf8");
    } else if (hex) {
        reason = `${fallback}: 0x${hex}`;
    }
    // ERC-7769's codes, by the EntryPoint's AA prefix.
    const aa = /^AA(\d)(\d)/.exec(reason);
    let code = -32500;
    if (aa?.[1] === "3") code = -32501;                       // paymaster
    if (aa && aa[1] === "2" && aa[2] === "4") code = -32507;  // signature
    if (aa && aa[1] === "2" && aa[2] === "2") code = -32503;  // outside its time range
    return new UserOpError(reason, code);
}

/** The EntryPoints that are actually deployed on this fork's parent. */
export async function supportedEntryPoints(env: Environment): Promise<string[]> {
    const out: string[] = [];
    for (const entry of ENTRY_POINTS) {
        if ((await env.getCode(entry.address)) !== "0x") out.push(entry.address);
    }
    return out;
}

const BLOCK_GAS = 30_000_000n;

function bundleGas(version: Version, op: UserOperation): bigint {
    let total = quantity(op, "callGasLimit") + quantity(op, "verificationGasLimit") + quantity(op, "preVerificationGas");
    if (version !== "0.6") total += quantity(op, "paymasterVerificationGasLimit") + quantity(op, "paymasterPostOpGasLimit");
    // Room for the EntryPoint's own bookkeeping, which no limit in the operation covers.
    const wanted = total + 500_000n;
    return wanted > BLOCK_GAS ? BLOCK_GAS : wanted;
}

export async function sendUserOperation(env: Environment, op: unknown, entryPointInput: unknown): Promise<{ hash: string; tx: StoredTx }> {
    if (!op || typeof op !== "object") throw new UserOpError("eth_sendUserOperation takes (userOp, entryPoint).", -32602);
    const { version, address: entryPoint } = versionOf(entryPointInput);
    if ((await env.getCode(entryPoint)) === "0x") {
        throw new UserOpError(`EntryPoint v${version} is not deployed on this chain.`, -32602);
    }
    const operation = op as UserOperation;
    const data = handleOpsData(version, operation);
    const gas = "0x" + bundleGas(version, operation).toString(16);

    // Simulated first: a bundler refuses an operation that would fail, rather
    // than paying to put a reverted bundle on chain.
    const simulated = await env.call({ from: BUNDLER, to: entryPoint, data, gas });
    if (simulated.reverted) throw refusal(simulated.returnValue, simulated.error ?? "the EntryPoint refused the operation");

    const tx = await env.sendTransaction({ from: BUNDLER, to: entryPoint, data, gas });
    if (tx.status !== 1) throw refusal(tx.revertData ?? undefined, tx.error ?? "handleOps reverted");
    const event = tx.logs.find((log) =>
        log.address.toLowerCase() === entryPoint.toLowerCase() && log.topics[0] === USER_OPERATION_EVENT);
    if (!event) throw new UserOpError("The bundle ran but the EntryPoint reported no operation.", -32500);
    return { hash: event.topics[1]!, tx };
}

/** The operation with this hash: the transaction that carried it, and where in its logs. */
export function findUserOperation(env: Environment, hash: unknown): { tx: StoredTx; index: number } | null {
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        throw new UserOpError("A user operation hash is 32 bytes of hex.", -32602);
    }
    const wanted = hash.toLowerCase();
    for (const tx of env.recentTransactions(Number.MAX_SAFE_INTEGER)) {
        const index = tx.logs.findIndex((log) => log.topics[0] === USER_OPERATION_EVENT && log.topics[1]?.toLowerCase() === wanted);
        if (index >= 0) return { tx, index };
    }
    return null;
}

/** Everything ERC-7769 puts in a user operation receipt, except the transaction receipt itself. */
export function describeReceipt(found: { tx: StoredTx; index: number }) {
    const { tx, index } = found;
    const event = tx.logs[index]!;
    const data = strip(event.data);
    const hash = event.topics[1]!.toLowerCase();
    const reasonLog = tx.logs.find((log) => log.topics[0] === REVERT_REASON_EVENT && log.topics[1]?.toLowerCase() === hash);
    // This operation's own logs: after the EntryPoint says execution begins
    // (or after the previous operation's event), and before its own event.
    let from = 0;
    for (let i = index - 1; i >= 0; i--) {
        const t = tx.logs[i]!.topics[0];
        if (t === USER_OPERATION_EVENT || t === BEFORE_EXECUTION) { from = i + 1; break; }
    }
    const entryPoint = event.address;
    return {
        userOpHash: event.topics[1],
        entryPoint,
        sender: "0x" + strip(event.topics[2]!).slice(24),
        nonce: "0x" + readWord(data, 0).toString(16),
        paymaster: "0x" + strip(event.topics[3]!).slice(24),
        actualGasCost: "0x" + readWord(data, 64).toString(16),
        actualGasUsed: "0x" + readWord(data, 96).toString(16),
        success: readWord(data, 32) === 1n,
        reason: reasonLog ? readBytes(strip(reasonLog.data), Number(readWord(strip(reasonLog.data), 32))) : "0x",
        logs: tx.logs.slice(from, index).filter((log) => log.address.toLowerCase() !== entryPoint.toLowerCase()),
    };
}

/** The operation itself, read back out of the handleOps call that carried it. */
export function describeOperation(found: { tx: StoredTx; index: number }) {
    const { tx, index } = found;
    const event = tx.logs[index]!;
    const entry = ENTRY_POINTS.find((e) => e.address.toLowerCase() === event.address.toLowerCase());
    if (!entry) return null;
    const sender = ("0x" + strip(event.topics[2]!).slice(24)).toLowerCase();
    const nonce = readWord(strip(event.data), 0);
    let ops: UserOperation[] = [];
    try { ops = decodeOps(entry.version, tx.input); } catch { /* not a handleOps call we can read */ }
    const operation = ops.find((op) => String(op.sender).toLowerCase() === sender && BigInt(String(op.nonce)) === nonce);
    return operation ? { userOperation: operation, entryPoint: entry.address, transactionHash: tx.hash } : null;
}

/** 16 gas for each non-zero byte of calldata, 4 for each zero. */
function calldataGas(hex: string): bigint {
    let gas = 0n;
    const clean = strip(hex);
    for (let i = 0; i < clean.length; i += 2) gas += clean.slice(i, i + 2) === "00" ? 4n : 16n;
    return gas;
}

/**
 * Limits that will be enough.
 *
 * The call is estimated for real, as the EntryPoint would make it. Verification
 * cannot be — it needs a valid signature, which the caller is estimating in
 * order to produce — so it gets a generous fixed limit. On a fork gas is free,
 * so a limit that is too high costs nothing and one that is too low fails the
 * operation; the numbers lean accordingly.
 */
export async function estimateUserOperationGas(env: Environment, op: unknown, entryPointInput: unknown) {
    if (!op || typeof op !== "object") throw new UserOpError("eth_estimateUserOperationGas takes (userOp, entryPoint).", -32602);
    const { version, address: entryPoint } = versionOf(entryPointInput);
    const operation = op as UserOperation;
    const sender = address(operation, "sender");
    const deploying = strip(initCodeOf(operation)) !== "";
    const callData = hexField(operation, "callData", "0x");

    let callGasLimit = 100_000n;
    if (strip(callData) && !deploying) {
        try {
            const estimate = await env.estimateGas({ from: entryPoint, to: sender, data: callData });
            callGasLimit = (estimate * 12n) / 10n + 10_000n;
        } catch (error) {
            throw new UserOpError(`The operation's call reverts: ${error instanceof Error ? error.message : String(error)}`, -32521);
        }
    } else if (deploying) {
        // The account does not exist yet, so its call cannot run on its own.
        callGasLimit = 1_000_000n;
    }

    const verificationGasLimit = deploying ? 2_000_000n : 500_000n;
    const padded = { ...operation, signature: hexField(operation, "signature", "0x") || "0x" };
    const preVerificationGas = 21_000n + calldataGas(encodeTuple(members(version, padded))) + 10_000n;
    const hex = (value: bigint) => "0x" + value.toString(16);
    const hasPaymaster = strip(paymasterAndDataOf(operation)) !== "";
    return {
        preVerificationGas: hex(preVerificationGas),
        verificationGasLimit: hex(verificationGasLimit),
        callGasLimit: hex(callGasLimit),
        ...(version !== "0.6" && hasPaymaster
            ? { paymasterVerificationGasLimit: hex(300_000n), paymasterPostOpGasLimit: hex(100_000n) }
            : {}),
    };
}
