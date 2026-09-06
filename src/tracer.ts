/**
 * What actually happened inside a transaction.
 *
 * The EVM announces every message and every opcode as it runs; a tracer is
 * nothing more than something listening. Two shapes come out of that:
 *
 *   - a **call tree**, one node per frame, which is what a person reads when
 *     they want to know why a transaction reverted;
 *   - **struct logs**, one entry per opcode, which is what a debugger steps
 *     through and what nobody wants by default — a swap is tens of thousands of
 *     them, and asking for that when you wanted the call tree is how a trace
 *     endpoint becomes something people stop using.
 *
 * So the call tree is always built and the struct logs are opt-in.
 */
import { bytesToHex } from "@ethereumjs/util";
import type { EVM } from "@ethereumjs/evm";

export interface TraceOptions {
    /**
     * Storage reads, writes and events, interleaved with the calls.
     *
     * Cheap enough to keep for every transaction — a swap has a handful of each,
     * against tens of thousands of opcodes — and it is what turns a call tree
     * into something you can actually read a transaction from.
     */
    storage?: boolean;
    /** Opcode-level entries. Off by default: they are enormous. */
    structLogs?: boolean;
    /** Stops collecting struct logs past this many, so one call cannot exhaust memory. */
    maxStructLogs?: number;
    /** Stack and memory roughly triple the size of each entry. */
    includeStack?: boolean;
    includeMemory?: boolean;
    /**
     * Only record opcodes matching this.
     *
     * The limit has to apply to what the caller asked for, not to what it was
     * filtered from: capping the raw stream at ten thousand and then keeping the
     * interesting ones means a long transaction is cut before it reaches them,
     * and the trace ends in the middle for no visible reason.
     */
    only?: RegExp;
}

/** One thing that happened inside a frame, in the order it happened. */
export interface FrameOp {
    kind: "sload" | "sstore" | "log";
    address: string;
    /** Storage slot, for a read or a write. */
    slot?: string;
    /** The value written, straight off the stack. */
    value?: string;
    topics?: string[];
    gasCost: string;
}

export interface CallFrame {
    type: "CALL" | "STATICCALL" | "DELEGATECALL" | "CREATE";
    from: string;
    to: string | null;
    value: string;
    gas: string;
    gasUsed: string;
    input: string;
    output: string;
    /** The revert reason if the contract gave one, or the EVM's own error. */
    error?: string;
    depth: number;
    /** Everything the frame did before its next call, in order. */
    ops: FrameOp[];
    calls: CallFrame[];
}

export interface StructLog {
    pc: number;
    op: string;
    gas: string;
    gasCost: string;
    depth: number;
    stack?: string[];
    memory?: string;
    error?: string;
}

export interface Trace {
    root: CallFrame | null;
    structLogs: StructLog[];
    /** True when collection stopped early, so a caller never mistakes a cut trace for a short one. */
    truncated: boolean;
}

const DEFAULT_MAX_LOGS = 20_000;

/** `Error(string)` — the only revert reason shape worth decoding without an ABI. */
function decodeRevert(output: Uint8Array): string | undefined {
    if (output.length < 4 + 32 + 32) return undefined;
    const selector = bytesToHex(output.subarray(0, 4));
    if (selector !== "0xdb1a2ee0" && selector !== "0x08c379a0") return undefined;
    try {
        const length = Number(BigInt(bytesToHex(output.subarray(36, 68))));
        return new TextDecoder().decode(output.subarray(68, 68 + length));
    } catch {
        return undefined;
    }
}

function frameType(message: {
    isCreate?: boolean;
    delegatecall?: boolean;
    isStatic?: boolean;
}): CallFrame["type"] {
    if (message.isCreate) return "CREATE";
    if (message.delegatecall) return "DELEGATECALL";
    if (message.isStatic) return "STATICCALL";
    return "CALL";
}

/**
 * Listens to one EVM for the duration of one execution.
 *
 * Returns a `stop()` that both detaches the listeners and hands back the trace —
 * leaving them attached would make every later call on this environment slower
 * and quietly accumulate frames from transactions nobody asked about.
 */
export function attachTracer(evm: EVM, options: TraceOptions = {}): () => Trace {
    const maxLogs = options.maxStructLogs ?? DEFAULT_MAX_LOGS;
    const wantLogs = options.structLogs === true;

    let root: CallFrame | null = null;
    const stack: CallFrame[] = [];
    const structLogs: StructLog[] = [];
    let truncated = false;

    const onBeforeMessage = (message: {
        to?: { toString(): string };
        caller: { toString(): string };
        value: bigint;
        gasLimit: bigint;
        data: Uint8Array;
        depth: number;
        isCreate?: boolean;
        delegatecall?: boolean;
        isStatic?: boolean;
    }) => {
        const frame: CallFrame = {
            type: frameType(message),
            from: message.caller.toString(),
            to: message.to?.toString() ?? null,
            value: "0x" + message.value.toString(16),
            gas: "0x" + message.gasLimit.toString(16),
            gasUsed: "0x0",
            input: bytesToHex(message.data ?? new Uint8Array()),
            output: "0x",
            depth: message.depth,
            ops: [],
            calls: [],
        };
        stack[stack.length - 1]?.calls.push(frame);
        root ??= frame;
        stack.push(frame);
    };

    const onAfterMessage = (result: {
        execResult: {
            executionGasUsed: bigint;
            returnValue: Uint8Array;
            exceptionError?: { error: string };
        };
        createdAddress?: { toString(): string };
    }) => {
        const frame = stack.pop();
        if (!frame) return;
        const { execResult } = result;
        frame.gasUsed = "0x" + execResult.executionGasUsed.toString(16);
        frame.output = bytesToHex(execResult.returnValue ?? new Uint8Array());
        if (result.createdAddress && frame.to === null) frame.to = result.createdAddress.toString();
        if (execResult.exceptionError) {
            frame.error = decodeRevert(execResult.returnValue) ?? execResult.exceptionError.error;
        }
    };

    /*
     * Storage and events, read off the stack as the opcode is about to run.
     *
     * The stack arrives bottom-first, so the operands are at the end: for
     * `SSTORE` the slot is the last word and the value the one before it. Taking
     * them here is the only moment they are knowable without re-executing.
     */
    const onStorageStep = (step: {
        stack: bigint[];
        depth: number;
        address: { toString(): string };
        opcode: { name: string; fee: number; dynamicFee?: bigint };
    }) => {
        const frame = stack[stack.length - 1];
        if (!frame) return;
        const op = step.opcode.name;
        const cost = "0x" + (BigInt(step.opcode.fee) + (step.opcode.dynamicFee ?? 0n)).toString(16);
        const word = (v: bigint | undefined) => "0x" + (v ?? 0n).toString(16).padStart(64, "0");
        const top = step.stack.length;

        if (op === "SLOAD") {
            frame.ops.push({
                kind: "sload", address: step.address.toString(),
                slot: word(step.stack[top - 1]), gasCost: cost,
            });
        } else if (op === "SSTORE") {
            frame.ops.push({
                kind: "sstore", address: step.address.toString(),
                slot: word(step.stack[top - 1]), value: word(step.stack[top - 2]), gasCost: cost,
            });
        } else if (/^LOG[0-4]$/.test(op)) {
            const count = Number(op.slice(3));
            const topics: string[] = [];
            // After offset and length come the topics, deepest first.
            for (let i = 0; i < count; i++) topics.push(word(step.stack[top - 3 - i]));
            frame.ops.push({
                kind: "log", address: step.address.toString(), topics, gasCost: cost,
            });
        }
    };

    const onStep = (step: {
        pc: number;
        gasLeft: bigint;
        depth: number;
        stack: bigint[];
        memory: Uint8Array;
        opcode: { name: string; fee: number; dynamicFee?: bigint };
    }) => {
        if (options.only && !options.only.test(step.opcode.name)) return;
        if (structLogs.length >= maxLogs) {
            truncated = true;
            return;
        }
        const entry: StructLog = {
            pc: step.pc,
            op: step.opcode.name,
            gas: "0x" + step.gasLeft.toString(16),
            gasCost: "0x" + (BigInt(step.opcode.fee) + (step.opcode.dynamicFee ?? 0n)).toString(16),
            depth: step.depth,
        };
        // The stack arrives bottom-first; every debugger shows it top-first.
        if (options.includeStack) {
            entry.stack = step.stack.map((word) => "0x" + word.toString(16)).reverse();
        }
        if (options.includeMemory) entry.memory = bytesToHex(step.memory);
        structLogs.push(entry);
    };

    const events = evm.events as unknown as {
        on(name: string, handler: (...args: never[]) => void): void;
        removeListener(name: string, handler: (...args: never[]) => void): void;
    };

    events.on("beforeMessage", onBeforeMessage as never);
    events.on("afterMessage", onAfterMessage as never);
    if (wantLogs) events.on("step", onStep as never);
    if (options.storage) events.on("step", onStorageStep as never);

    return () => {
        events.removeListener("beforeMessage", onBeforeMessage as never);
        events.removeListener("afterMessage", onAfterMessage as never);
        if (wantLogs) events.removeListener("step", onStep as never);
        if (options.storage) events.removeListener("step", onStorageStep as never);
        return { root, structLogs, truncated };
    };
}
