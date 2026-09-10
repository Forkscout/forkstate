/**
 * One forked chain.
 *
 * Nothing is copied from the parent network. `RPCStateManager` reads an account
 * or a slot from the upstream node the first time it is asked for and caches it;
 * anything written stays local and never leaves. So an environment is worth its
 * writes and nothing else — an untouched one is a few hundred bytes, and it stays
 * current with the parent chain until a write shadows a value.
 */
import { ForkStateManager } from "./state-manager.ts";
import type { UpstreamCache } from "./upstream-cache.ts";
import { createVM } from "@ethereumjs/vm";
import { Common, Mainnet } from "@ethereumjs/common";
import { createTxFromRLP } from "@ethereumjs/tx";
import { RLP } from "@ethereumjs/rlp";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { Account, Address, bytesToHex, createAddressFromString, hexToBytes, utf8ToBytes } from "@ethereumjs/util";
import type { VM } from "@ethereumjs/vm";

import { emptyOverlay, normaliseAddress, normaliseWord, overlaySize, type Overlay } from "./overlay.ts";
import { Chain, type StoredBlock, type StoredTx } from "./chain.ts";
import { attachTracer, type Trace, type TraceOptions } from "./tracer.ts";
import { logMatches, type LogFilter } from "./logs.ts";
import type { Log, TransactionRequest } from "./types.ts";

export interface EnvironmentOptions {
    /** Shared with every other environment: the parent's state is the same for all of them. */
    cache?: UpstreamCache | null;
    /**
     * Rounds an unpinned fork down to a multiple of this, so environments created
     * near each other land on the same block.
     *
     * Without it the shared cache is worthless for the common case: every fork
     * taken at "latest" gets its own height, and two environments a second apart
     * are asking about different chains as far as a cache key is concerned.
     * Measured on BNB Chain, sharing a fork point took a first read from 1,225 ms
     * to 28 ms for everyone after.
     */
    checkpoint?: number;
    /** Upstream node. Only standard read methods are used — no debug_* and no archive tier. */
    rpcUrl: string;
    /** The height reads fall through to. Pinning it is what makes a run reproducible. */
    forkBlock?: bigint;
    /** Defaults to the parent's. A distinct one stops a wallet answering from its own services. */
    chainId?: number;
}

/**
 * State to pretend is true for the length of one call.
 *
 * The shape Geth settled on, because tools already speak it: an address maps to
 * the fields to replace. Nothing here touches the testnet — the call already runs
 * inside a checkpoint that is always thrown away, and the overrides go inside it.
 *
 * `stateDiff` patches the slots named. `state` in Geth means the opposite — the
 * account's storage is exactly this and every other slot reads as zero — which a
 * read-through fork cannot honour, because the slots to blank are the ones it has
 * never fetched and cannot enumerate. It is refused by name rather than quietly
 * treated as a patch, which would answer a different question than the one asked.
 */
export interface StateOverride {
    balance?: string;
    nonce?: string;
    code?: string;
    stateDiff?: Record<string, string>;
    state?: Record<string, string>;
}

export type StateOverrides = Record<string, StateOverride>;

export interface CallRequest {
    from?: string;
    to?: string;
    data?: string;
    value?: string;
    gas?: string;
    /**
     * The same thing as `data`, under the name the execution APIs standardised on.
     *
     * Foundry sends `input`; ethers and older tools send `data`. Reading only one
     * of them treats a contract deployment as an empty transfer — which then
     * estimates at 21,000 gas and dies out of gas, with nothing in the error to
     * suggest the calldata was dropped on the way in.
     */
    input?: string;
}

export interface CallResult {
    returnValue: string;
    gasUsed: string;
    reverted: boolean;
    error: string | null;
    /** The bytes the revert returned, for a caller that holds the ABI. */
    revertData?: string | null;
}

/**
 * One transaction's worth of a bundle, after it ran.
 *
 * Shaped like a receipt rather than like `eth_call`'s answer, because that is
 * the question being asked: not "what does this return" but "what would this
 * do, and then what would the next one do on top of it".
 */
export interface BundleResult {
    index: number;
    from: string;
    to: string | null;
    /** 1 or 0, as a receipt reports it. */
    status: 0 | 1;
    gasUsed: string;
    returnValue: string;
    /** The decoded revert reason, when there was one. */
    error: string | null;
    revertData: string | null;
    contractAddress: string | null;
    logs: Array<{ address: string; topics: string[]; data: string; logIndex: string }>;
    trace?: Trace;
    diff?: StateDiff;
}

export interface BundleOptions {
    /** Pretended state, applied once before the first transaction. */
    overrides?: StateOverrides;
    /** Call tree and opcodes per transaction. Off by default; it is not cheap. */
    trace?: boolean;
    /** Before-and-after for everything each transaction wrote. */
    diff?: boolean;
}

/**
 * How many transactions one bundle may contain.
 *
 * Each one runs the EVM and may reach the parent chain for state it has not
 * seen, so a bundle is the one request a caller can make arbitrarily expensive
 * by making it longer. This is generous for the thing bundles are for — a
 * setup, the transaction under test, and the assertions around it.
 */
const MAX_BUNDLE = 64;

/** Nobody's key. Used when a call arrives without a sender, which is normal for eth_call. */
const ANONYMOUS = "0x0000000000000000000000000000000000000000";
/**
 * Solidity's panic codes, as the compiler documents them. A person reading
 * "0x11" has to go look it up; a person reading "arithmetic overflow" does not.
 */
const PANIC: Record<string, string> = {
    "": "generic panic",
    "1": "assertion failed",
    "11": "arithmetic overflow or underflow",
    "12": "division or modulo by zero",
    "21": "value does not fit the enum",
    "22": "storage byte array is encoded wrong",
    "31": "pop() on an empty array",
    "32": "index out of bounds",
    "41": "allocated more memory than is possible",
    "51": "called a zero-initialised function variable",
};

const DEFAULT_GAS = 30_000_000n;

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await res.json() as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
}

/**
 * The chain a transaction was signed for, read straight off the payload.
 *
 * This has to happen before the transaction is parsed, not after: handing a
 * mismatched chain to a parser gets you "Incompatible EIP155-based V 14714148",
 * which tells a developer nothing about the one thing they got wrong.
 * Returns undefined for a pre-EIP155 signature, which is bound to no chain.
 */
function signedChainId(raw: Uint8Array): bigint | undefined {
    const toBigInt = (v: unknown) =>
        v instanceof Uint8Array && v.length > 0 ? BigInt(bytesToHex(v)) : 0n;
    try {
        if (raw[0]! >= 0xc0) {
            // Legacy: EIP-155 folds the chain into v as chainId * 2 + 35.
            const v = toBigInt((RLP.decode(raw) as Uint8Array[])[6]);
            return v >= 35n ? (v - 35n) / 2n : undefined;
        }
        // Typed (EIP-2718): chain id is the first field of the payload.
        return toBigInt((RLP.decode(raw.subarray(1)) as Uint8Array[])[0]);
    } catch {
        return undefined;
    }
}

/**
 * A poll cursor, which is all a filter is.
 *
 * These have to live in the environment rather than be forwarded: a filter made
 * on the parent watches the parent, so a dapp calling `contract.on(...)` against
 * a fork would sit there receiving mainnet's events and none of its own.
 */
interface Filter {
    kind: "log" | "block";
    criteria: LogFilter & { fromBlock?: number; toBlock?: number };
    /** The last height already reported, so a poll returns only what is new. */
    cursor: number;
}

/** Improbable as a real balance, so seeing it back means the write was noticed. */
const SENTINEL = 0x1234567890abcdef1234567890abcdefn;

const word = (value: bigint) => "0x" + value.toString(16).padStart(64, "0");



/** Where a `mapping(address => uint256)` keeps one holder's entry. */
function mappingSlot(holder: string, index: number, layout: "solidity" | "vyper"): string {
    const key = holder.slice(2).toLowerCase().padStart(64, "0");
    const position = index.toString(16).padStart(64, "0");
    const preimage = layout === "solidity" ? key + position : position + key;
    return bytesToHex(keccak_256(hexToBytes(("0x" + preimage) as `0x${string}`)));
}

/** Before and after, for everything one transaction touched. */
export interface StateDiff {
    accounts: Record<string, {
        balance: { before: string; after: string };
        nonce: { before: string; after: string };
    }>;
    storage: Record<string, Record<string, { before: string; after: string }>>;
}

/** Calldata under either name, because both are in use. */
function callData(request: { data?: string; input?: string }): Uint8Array {
    const hex = request.data ?? request.input;
    return hex && hex !== "0x" ? hexToBytes(hex as `0x${string}`) : new Uint8Array();
}

/**
 * The well-known local-development accounts.
 *
 * Derived from the mnemonic every local chain uses ("test test … junk"), so a
 * key a developer already has in a script keeps working here.
 */
const DEV_ACCOUNTS = [
    "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
    "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
    "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
    "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
    "0x976ea74026e726554db657fa54763abd0c3a0aa9",
    "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
    "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f",
    "0xa0ee7a142d267c1f36714e4a8f75612f20a79720",
];

export class Environment {
    /** Changed through `setChainId`, which has to rebuild the VM to match. */
    chainId: number;
    /** Moves when this fork follows the parent's head. */
    forkBlock: bigint;

    /** Whether a scheduled sync should pull this one forward. */
    followsHead = false;
    private readonly rpcUrl: string;
    private state: ForkStateManager;
    private readonly cache: UpstreamCache | null;
    private common: Common;
    private vm: VM;
    private readonly overlay: Overlay;
    private chain: Chain;
    /** Wall-clock offset applied to new blocks, moved by evm_increaseTime. */
    private timeOffset = 0;
    /** Every address allowed to send without a key. A devnet exists to do this. */
    private readonly impersonated = new Set<string>();
    private readonly filters = new Map<string, Filter>();
    /**
     * Call trees, kept from when each transaction ran.
     *
     * Re-simulating a past transaction is the other way to answer this, and it
     * is the wrong one here: state has moved on since, so the replay would
     * describe an execution that never happened. Capturing at the time is exact.
     *
     * Only the tree — struct logs are thousands of entries per transaction and
     * are produced on demand by `debug_traceCall` instead.
     */
    /**
     * Where traces go to outlive the process, if anything was given.
     *
     * The maps below are a cache in front of it. Without one, every redeploy —
     * and every eviction of an idle environment — silently emptied the trace and
     * state tabs of every transaction already in the explorer, which is exactly
     * the history a person opens an explorer to read.
     */
    /**
     * Told when this environment causes a read of the parent chain.
     *
     * The expensive thing, and the only one worth metering: a warm call is
     * milliseconds and free, a cold one is most of a second and is somebody's
     * paid request.
     */
    set onUpstreamFetch(fn: (() => void) | null) {
        this.upstreamFetch = fn;
        this.state.onUpstreamFetch = fn;
    }

    /**
     * Kept here as well as on the state manager, because the state manager is
     * replaced whole — on a chain-id change, a head sync, a revert — and a hook
     * that lived only on it would go quiet after the first of those, which is
     * the sort of thing nobody notices until a bill is wrong.
     */
    private upstreamFetch: (() => void) | null = null;

    archive: {
        save(hash: string, trace: Trace, diff: StateDiff | null): Promise<void>;
        load(hash: string): Promise<{ trace: Trace; diff: StateDiff | null } | null>;
    } | null = null;

    private readonly traces = new Map<string, Trace>();
    /** Held between running a transaction and knowing the hash to file it under. */
    private pendingTrace: Trace | null = null;

    /**
     * What each transaction changed, kept for the same reason its trace is: it
     * cannot be worked out afterwards. "The balance is X now" is a fact; "this
     * transaction moved it from Y to X" is the one people actually want, and the
     * only moment Y is knowable is before the write lands.
     */
    private readonly diffs = new Map<string, StateDiff>();
    private capturing: StateDiff | null = null;

    /**
     * Bumped whenever this environment changes, so a caller can tell whether it
     * is worth writing out.
     *
     * Persisting after every request was fine when the store was a file on the
     * same disk. Against Postgres — and especially one in another region — it
     * turned every read-only `eth_call` into a full round-trip write of the
     * whole row, which is most of a second before anything else happens.
     */
    private revision = 0;

    /** What `revision` is now. Equal values mean nothing has changed since. */
    get version(): number {
        return this.revision;
    }
    /**
     * Set while writing something the overlay must not learn about.
     *
     * Separate from `recording` because `call()` owns that one and sets it back
     * to true when it finishes — a probe that calls into a contract would have
     * its suppression switched off underneath it.
     */
    private suppress = false;
    /**
     * Told about every block this environment mines.
     *
     * A set of callbacks rather than an EventEmitter: there is exactly one event
     * and exactly one thing listening for it — the socket layer — and a typed
     * function is easier to be sure about than a string.
     */
    private readonly watchers = new Set<(block: StoredBlock, txs: StoredTx[]) => void>();
    private nextFilterId = 1;
    private autoImpersonate = false;
    /** Off while a call runs: a call is reverted, so what it wrote is not ours to keep. */
    private recording = true;

    // Written out rather than declared as constructor parameters: Node's type
    // stripping erases types without emitting code, and parameter properties are
    // the one TypeScript feature that needs code emitted to work.
    private constructor(
        chainId: number,
        forkBlock: bigint,
        rpcUrl: string,
        state: ForkStateManager,
        vm: VM,
        overlay: Overlay,
        chain: Chain,
        cache: UpstreamCache | null,
        common: Common,
    ) {
        this.chainId = chainId;
        this.forkBlock = forkBlock;
        this.rpcUrl = rpcUrl;
        this.state = state;
        this.vm = vm;
        this.overlay = overlay;
        this.chain = chain;
        this.cache = cache;
        this.common = common;
    }

    static async create(options: EnvironmentOptions): Promise<Environment> {
        const { rpcUrl } = options;

        const parentChainId = Number(BigInt(await rpc<string>(rpcUrl, "eth_chainId", [])));
        let forkBlock = options.forkBlock;
        if (forkBlock === undefined) {
            const head = BigInt(await rpc<string>(rpcUrl, "eth_blockNumber", []));
            const checkpoint = BigInt(options.checkpoint ?? 0);
            forkBlock = checkpoint > 1n ? (head / checkpoint) * checkpoint : head;
        }
        const chainId = options.chainId ?? parentChainId;

        const state = new ForkStateManager({ provider: rpcUrl, blockTag: forkBlock, cache: options.cache });
        // Mainnet rules with the chain id swapped: the fork runs the same EVM as the
        // network it reads from, which is the only way its results mean anything.
        const common = new Common({ chain: { ...Mainnet, chainId } });
        const vm = await createVM({ common, stateManager: state });

        const env = new Environment(
            chainId, forkBlock, rpcUrl, state, vm,
            emptyOverlay(chainId, forkBlock),
            new Chain(Number(forkBlock)),
            options.cache ?? null,
            common,
        );
        env.recordWrites();
        return env;
    }

    /**
     * Sends every write through the overlay on its way to the state manager.
     *
     * Intercepting here rather than in the setters is what catches storage a
     * *contract* wrote during execution. Without it an environment would execute
     * correctly and then restore wrong, which is the one failure this design
     * exists to prevent — and the kind that is only noticed much later.
     */
    private recordWrites(): void {
        const state = this.state as unknown as {
            putStorage: (a: Address, k: Uint8Array, v: Uint8Array) => Promise<void>;
            putAccount: (a: Address, acc?: Account) => Promise<void>;
            putCode: (a: Address, c: Uint8Array) => Promise<void>;
        };

        const putStorage = state.putStorage.bind(state);
        const putAccount = state.putAccount.bind(state);
        const putCode = state.putCode.bind(state);

        state.putStorage = async (address, key, value) => {
            // A fill is the parent's value arriving, not this environment deciding
            // anything. Recording it would grow the overlay for nothing and freeze
            // a value that should keep tracking the parent.
            const isFill = (this.state as ForkStateManager).filling;
            if (this.recording && !this.suppress && !isFill) {
                const account = this.track(address.toString());
                (account.storage ??= {})[normaliseWord(bytesToHex(key))] = normaliseWord(bytesToHex(value));
            }
            if (this.capturing && !isFill) {
                await this.noteSlot(address.toString(), bytesToHex(key), bytesToHex(value));
            }
            return putStorage(address, key, value);
        };

        state.putAccount = async (address, account) => {
            if (this.capturing && account) await this.noteAccount(address, account);
            if (this.recording && !this.suppress && account) {
                const entry = this.track(address.toString());
                entry.balance = "0x" + account.balance.toString(16);
                entry.nonce = "0x" + account.nonce.toString(16);
            }
            return putAccount(address, account);
        };

        state.putCode = async (address, code) => {
            if (this.recording && !this.suppress) this.track(address.toString()).code = bytesToHex(code);
            return putCode(address, code);
        };
    }

    // ---- reads --------------------------------------------------------------

    async getBalance(address: string): Promise<bigint> {
        const account = await this.state.getAccount(createAddressFromString(normaliseAddress(address)));
        return account?.balance ?? 0n;
    }

    async getNonce(address: string): Promise<bigint> {
        const account = await this.state.getAccount(createAddressFromString(normaliseAddress(address)));
        return account?.nonce ?? 0n;
    }

    async getCode(address: string): Promise<string> {
        return bytesToHex(await this.state.getCode(createAddressFromString(normaliseAddress(address))));
    }

    async getStorageAt(address: string, slot: string): Promise<string> {
        const value = await this.state.getStorage(
            createAddressFromString(normaliseAddress(address)),
            hexToBytes(normaliseWord(slot) as `0x${string}`),
        );
        // A never-written slot comes back empty rather than as thirty-two zeros.
        return value.length === 0 ? normaliseWord("0x0") : normaliseWord(bytesToHex(value));
    }

    // ---- writes -------------------------------------------------------------

    private track(address: string): Overlay["accounts"][string] {
        // A suppressed write is bookkeeping — a probe, or putting a slot back the
        // way it was found. Recording it would make the overlay own a value it
        // never chose, which is both a lie and a cost.
        // A fresh one each time: a shared object would accumulate every
        // discarded write for the life of the process.
        if (this.suppress) return {};
        this.revision++;
        const key = normaliseAddress(address);
        return this.overlay.accounts[key] ??= {};
    }

    async setBalance(address: string, wei: bigint): Promise<void> {
        const addr = createAddressFromString(normaliseAddress(address));
        const account = (await this.state.getAccount(addr)) ?? new Account();
        account.balance = wei;
        await this.state.putAccount(addr, account);
        this.track(address).balance = "0x" + wei.toString(16);
    }

    async setNonce(address: string, nonce: bigint): Promise<void> {
        const addr = createAddressFromString(normaliseAddress(address));
        const account = (await this.state.getAccount(addr)) ?? new Account();
        account.nonce = nonce;
        await this.state.putAccount(addr, account);
        this.track(address).nonce = "0x" + nonce.toString(16);
    }

    async setCode(address: string, code: string): Promise<void> {
        const addr = createAddressFromString(normaliseAddress(address));
        await this.state.putCode(addr, hexToBytes(code as `0x${string}`));
        this.track(address).code = code;
    }

    async setStorageAt(address: string, slot: string, value: string): Promise<void> {
        const addr = createAddressFromString(normaliseAddress(address));
        const key = normaliseWord(slot);
        const word = normaliseWord(value);
        await this.state.putStorage(addr, hexToBytes(key as `0x${string}`), hexToBytes(word as `0x${string}`));
        const account = this.track(address);
        (account.storage ??= {})[key] = word;
    }

    // ---- execution ----------------------------------------------------------

    /** Runs a call and throws the result away — the overlay is untouched. */
    async call(request: CallRequest, overrides?: StateOverrides): Promise<CallResult> {
        // A checkpoint that is always reverted: `eth_call` must not be able to
        // change anything, and running it against the live overlay would.
        await this.state.checkpoint();
        this.recording = false;
        try {
            // Inside the checkpoint, so they are undone with everything else.
            if (overrides) await this.applyOverrides(overrides);
            const result = await this.vm.evm.runCall({
                caller: createAddressFromString(normaliseAddress(request.from ?? ANONYMOUS)),
                to: request.to ? createAddressFromString(normaliseAddress(request.to)) : undefined,
                data: callData(request),
                value: request.value ? BigInt(request.value) : 0n,
                gasLimit: request.gas ? BigInt(request.gas) : DEFAULT_GAS,
            });
            const exec = result.execResult;
            const reverted = Boolean(exec.exceptionError);
            return {
                returnValue: bytesToHex(exec.returnValue),
                gasUsed: "0x" + exec.executionGasUsed.toString(16),
                reverted,
                // The decoded reason, the same one a receipt carries. The raw EVM
                // error says "revert" and nothing more; the contract usually said
                // why, and this is the only place a caller can be told.
                error: reverted ? this.revertReason(exec) : null,
                revertData: reverted ? bytesToHex(exec.returnValue) : null,
            };
        } finally {
            this.recording = true;
            await this.state.revert();
        }
    }

    /**
     * Writes the pretended state, for the length of the surrounding checkpoint.
     *
     * Recording is already off here, so none of this reaches the overlay: what is
     * written is visible to the call and to nothing afterwards.
     */
    private async applyOverrides(overrides: StateOverrides): Promise<void> {
        for (const [ rawAddress, override ] of Object.entries(overrides)) {
            if (override.state) {
                throw new Error(
                    `state override for ${rawAddress}: "state" replaces an account's whole `
                    + "storage, which a fork cannot do — the slots it would have to blank are "
                    + "the ones it has never read. Use \"stateDiff\" to set the slots you mean.",
                );
            }

            const address = createAddressFromString(normaliseAddress(rawAddress));

            if (override.balance !== undefined || override.nonce !== undefined) {
                const account = (await this.state.getAccount(address)) ?? new Account();
                if (override.balance !== undefined) account.balance = BigInt(override.balance);
                if (override.nonce !== undefined) account.nonce = BigInt(override.nonce);
                await this.state.putAccount(address, account);
            }

            if (override.code !== undefined) {
                await this.state.putCode(address, hexToBytes(override.code as `0x${string}`));
            }

            for (const [ slot, value ] of Object.entries(override.stateDiff ?? {})) {
                await this.state.putStorage(
                    address,
                    hexToBytes(normaliseWord(slot) as `0x${string}`),
                    hexToBytes(normaliseWord(value) as `0x${string}`),
                );
            }
        }
    }

    /**
     * Runs several transactions in sequence and throws all of it away.
     *
     * The difference from calling `eth_call` three times is the only thing that
     * matters here: each transaction sees what the ones before it did. An
     * approve followed by a swap is two calls that fail separately and one
     * bundle that works, and "why did this revert on chain when it simulated
     * fine" is nearly always a sequence that was never simulated as one.
     *
     * Nothing survives. The whole bundle runs inside a checkpoint that is always
     * reverted, exactly as `call()` does, so asking cannot change the fork.
     *
     * Each transaction also gets a checkpoint of its own, so a revert undoes
     * that transaction and not the ones before it — and the bundle keeps going,
     * because a caller who sent five transactions wants to know about all five
     * and not only up to the first failure.
     */
    async simulateBundle(
        transactions: CallRequest[], options: BundleOptions = {},
    ): Promise<{ results: BundleResult[]; gasUsed: string; failed: boolean }> {
        if (!Array.isArray(transactions) || transactions.length === 0) {
            throw new Error("a bundle needs at least one transaction");
        }
        if (transactions.length > MAX_BUNDLE) {
            throw new Error(
                `a bundle may hold ${MAX_BUNDLE} transactions; this one has ${transactions.length}`,
            );
        }

        await this.state.checkpoint();
        // The overlay must not learn about any of this: it is all about to be
        // reverted, and a recorded write would outlive the state behind it.
        this.recording = false;
        try {
            if (options.overrides) await this.applyOverrides(options.overrides);

            const results: BundleResult[] = [];
            let total = 0n;
            for (const [ index, request ] of transactions.entries()) {
                const result = await this.simulateOne(index, request, options);
                total += BigInt(result.gasUsed);
                results.push(result);
            }
            return {
                results,
                gasUsed: "0x" + total.toString(16),
                failed: results.some((result) => result.status === 0),
            };
        } finally {
            this.recording = true;
            this.capturing = null;
            await this.state.revert();
        }
    }

    /** One transaction of a bundle, on top of whatever the ones before it left. */
    private async simulateOne(
        index: number, request: CallRequest, options: BundleOptions,
    ): Promise<BundleResult> {
        const from = normaliseAddress(request.from ?? ANONYMOUS);
        const sender = createAddressFromString(from);
        const to = request.to ? normaliseAddress(request.to) : null;
        const account = (await this.state.getAccount(sender)) ?? new Account();
        const value = request.value ? BigInt(request.value) : 0n;

        const empty: BundleResult = {
            index, from, to,
            status: 0,
            gasUsed: "0x0",
            returnValue: "0x",
            error: null,
            revertData: null,
            contractAddress: null,
            logs: [],
        };

        /*
         * Refused before it runs, the way a chain refuses to include it.
         *
         * Reported rather than thrown: this transaction cannot go in, but the
         * ones after it still can, and a caller asking about five transactions
         * should hear about five.
         */
        if (value > account.balance) {
            return {
                ...empty,
                error: `insufficient funds for transfer: address ${from} has `
                    + `${account.balance}, wants ${value}`,
            };
        }

        await this.state.checkpoint();
        const stopTracing = options.trace
            ? attachTracer(this.vm.evm as never, { storage: true })
            : null;
        if (options.diff) this.capturing = { accounts: {}, storage: {} };

        let trace: Trace | null = null;
        let result;
        try {
            try {
                result = await this.vm.evm.runCall({
                    caller: sender,
                    to: to ? createAddressFromString(to) : undefined,
                    data: callData(request),
                    value,
                    gasLimit: request.gas ? BigInt(request.gas) : DEFAULT_GAS,
                });
            } finally {
                // Off before anything else can throw, or it stays attached to
                // this environment for every call that follows.
                trace = stopTracing ? stopTracing() : null;
            }
        } catch (error) {
            this.capturing = null;
            await this.state.revert();
            // The EVM refused to start — a malformed target, a gas limit it
            // cannot honour. Same treatment as a revert: reported, not fatal.
            return { ...empty, error: error instanceof Error ? error.message : String(error) };
        }

        const exec = result.execResult;
        const reverted = Boolean(exec.exceptionError);
        const diff = this.capturing;
        this.capturing = null;
        if (trace && diff) await this.resolveReads(trace, diff);

        if (reverted) {
            await this.state.revert();
        } else {
            // The EVM run does not advance the sender's nonce; a chain does, and
            // the next transaction in this bundle is entitled to see it.
            const settled = (await this.state.getAccount(sender)) ?? account;
            settled.nonce = account.nonce + 1n;
            await this.state.putAccount(sender, settled);
            await this.state.commit();
        }

        /*
         * A reverted transaction still spends its nonce on a real chain, and the
         * next transaction from the same sender has to account for that. Written
         * after the revert, so it survives it — and still inside the bundle's own
         * checkpoint, so it goes away with everything else.
         */
        if (reverted) {
            const after = (await this.state.getAccount(sender)) ?? account;
            after.nonce = account.nonce + 1n;
            await this.state.putAccount(sender, after);
        }

        return {
            index, from, to,
            status: reverted ? 0 : 1,
            gasUsed: "0x" + exec.executionGasUsed.toString(16),
            returnValue: bytesToHex(exec.returnValue),
            error: reverted ? this.revertReason(exec) : null,
            revertData: reverted ? bytesToHex(exec.returnValue) : null,
            contractAddress: result.createdAddress ? result.createdAddress.toString() : null,
            // No block is mined, so these carry no block hash. What a caller
            // wants from a simulated log is which contract said what, and that
            // is all here.
            logs: (exec.logs ?? []).map((entry, i) => ({
                address: bytesToHex(entry[0]),
                topics: entry[1].map((topic) => bytesToHex(topic)),
                data: bytesToHex(entry[2]),
                logIndex: "0x" + i.toString(16),
            })),
            ...(trace ? { trace } : {}),
            // Only for a transaction that succeeded. A reverted one's writes were
            // undone, and reporting them as state changes would describe a world
            // that does not exist — the trace is where you look at what it tried.
            ...(diff && !reverted ? { diff } : {}),
        };
    }

    // ---- transactions -------------------------------------------------------

    /**
     * Executes a transaction and mines a block for it.
     *
     * The sender is taken from the request rather than recovered from a signature.
     * On a devnet that is the point — you send as a whale or a multisig you hold no
     * key for — and it is what `anvil_impersonateAccount` exists to allow. A signed
     * transaction is accepted too; its signature simply is not what decides who sent it.
     */
    async sendTransaction(request: TransactionRequest, signedHash?: string): Promise<StoredTx> {
        const from = normaliseAddress(request.from ?? ANONYMOUS);
        if (!this.autoImpersonate && !this.impersonated.has(from) && !this.isDevAccount(from)) {
            // Not a hard error: a devnet that refuses unknown senders is a devnet
            // nobody can drive. It is recorded so the caller knows it happened.
            this.impersonated.add(from);
        }

        const sender = createAddressFromString(from);
        const account = (await this.state.getAccount(sender)) ?? new Account();
        const nonce = request.nonce !== undefined ? BigInt(request.nonce) : account.nonce;
        const gasLimit = request.gas ? BigInt(request.gas) : DEFAULT_GAS;
        const value = request.value ? BigInt(request.value) : 0n;
        const data = request.data ?? request.input ?? "0x";

        // Refused up front, the way a chain refuses it. The EVM would otherwise
        // revert somewhere inside the call, which says far less about why.
        if (value > 0n && account.balance < value) {
            throw new Error(
                `insufficient funds for transfer: address ${from} has ${account.balance}, `
                + `wants ${value}`,
            );
        }

        // Traced as it runs. A transaction is the one execution that cannot be
        // reproduced later: state moves on, so a replay would describe something
        // that never happened.
        const stopTracing = attachTracer(this.vm.evm as never, { storage: true });
        this.capturing = { accounts: {}, storage: {} };
        let result;
        try {
            result = await this.vm.evm.runCall({
                caller: sender,
                to: request.to ? createAddressFromString(normaliseAddress(request.to)) : undefined,
                data: hexToBytes(data as `0x${string}`),
                value,
                gasLimit,
            });
        } finally {
            this.pendingTrace = stopTracing();
        }

        const exec = result.execResult;
        const reverted = Boolean(exec.exceptionError);

        /*
         * The account is read again rather than reused.
         *
         * `account` was fetched before execution, and the EVM has since moved
         * the sender's balance. Writing that stale object back to set the nonce
         * put the old balance back with it — so a transfer credited the
         * recipient and left the sender untouched, and an account holding one
         * ether could send a hundred. The value was never missing; it was being
         * restored a line later.
         */
        const settled = (await this.state.getAccount(sender)) ?? account;

        // The EVM run does not advance the sender's nonce; a chain does.
        settled.nonce = nonce + 1n;
        await this.state.putAccount(sender, settled);
        const entry = this.track(from);
        entry.nonce = "0x" + settled.nonce.toString(16);
        entry.balance = "0x" + settled.balance.toString(16);

        const created = result.createdAddress ? result.createdAddress.toString() : null;
        const gasUsed = exec.executionGasUsed;
        // A signed transaction already has a hash, and it is the one the sender is
        // polling for a receipt on — inventing our own would strand the wallet.
        const hash = signedHash ?? this.hashFor(from, nonce, data, value);
        if (this.pendingTrace) {
            this.traces.set(hash.toLowerCase(), this.pendingTrace);
            this.pendingTrace = null;
        }
        if (this.capturing) {
            const diff = this.capturing;
            this.capturing = null;
            const trace = this.traces.get(hash.toLowerCase());
            if (trace) await this.resolveReads(trace, diff);
            this.diffs.set(hash.toLowerCase(), diff);
        }
        const index = 0;
        const blockNumber = this.chain.height + 1;

        const logs: Log[] = (exec.logs ?? []).map((entry, i) => ({
            address: bytesToHex(entry[0]),
            topics: entry[1].map((topic) => bytesToHex(topic)),
            data: bytesToHex(entry[2]),
            blockNumber: "0x" + blockNumber.toString(16),
            transactionHash: hash,
            transactionIndex: "0x" + index.toString(16),
            blockHash: "0x" + "0".repeat(64),
            logIndex: "0x" + i.toString(16),
            removed: false,
        }));

        const tx: StoredTx = {
            hash,
            blockNumber,
            transactionIndex: index,
            from,
            to: request.to ? normaliseAddress(request.to) : null,
            value: "0x" + value.toString(16),
            input: data,
            nonce: Number(nonce),
            gas: "0x" + gasLimit.toString(16),
            gasPrice: request.gasPrice ?? "0x0",
            gasUsed: "0x" + gasUsed.toString(16),
            status: reverted ? 0 : 1,
            contractAddress: created,
            logs,
            error: reverted ? this.revertReason(exec) : null,
            revertData: reverted ? bytesToHex(exec.returnValue) : null,
        };

        this.mineBlock([ tx ], gasUsed);
        // Written once, here, where the trace is complete and will never change
        // again. A failure to archive must not fail the transaction that has
        // already run, so it is reported and left at that.
        if (this.archive) {
            const trace = this.traces.get(hash.toLowerCase());
            if (trace) {
                void this.archive.save(hash.toLowerCase(), trace, this.diffs.get(hash.toLowerCase()) ?? null)
                    .catch((error: unknown) => {
                        console.error(`could not archive the trace for ${hash}:`, error);
                    });
            }
        }
        // Written after the block exists, so a log never names a block that does not.
        const block = this.chain.latest()!;
        // The transaction learns which block it landed in only now, when the
        // block exists. Its receipt and every client that correlates by block
        // hash read this.
        tx.blockHash = block.hash;
        for (const log of tx.logs) log.blockHash = block.hash;

        // Last, when the block, the receipt and every log in it are all true.
        this.announce(block, [ tx ]);

        return tx;
    }

    /**
     * A signed transaction, as a wallet sends it.
     *
     * The sender comes from the signature here, not from a field — that is the
     * whole difference between this and `eth_sendTransaction`, and it is why a
     * wallet can use this fork without the fork having to trust the caller.
     */
    async sendRawTransaction(raw: string): Promise<StoredTx> {
        const bytes = hexToBytes(raw as `0x${string}`);
        const signedFor = signedChainId(bytes);
        if (signedFor !== undefined && signedFor !== BigInt(this.chainId)) {
            throw new Error(
                `Transaction is signed for chain ${signedFor}, but this fork is chain ${this.chainId}. `
                + `Point your wallet at this fork's chain id.`,
            );
        }

        const tx = createTxFromRLP(bytes, { common: this.common });
        if (!tx.isSigned()) throw new Error("Transaction is not signed.");

        const sender = tx.getSenderAddress().toString();
        return this.sendTransaction({
            from: sender,
            to: tx.to?.toString(),
            data: bytesToHex(tx.data),
            value: "0x" + tx.value.toString(16),
            gas: "0x" + tx.gasLimit.toString(16),
            nonce: "0x" + tx.nonce.toString(16),
            gasPrice: "gasPrice" in tx ? "0x" + (tx as { gasPrice: bigint }).gasPrice.toString(16) : "0x0",
        }, bytesToHex(tx.hash()));
    }

    /** Whether this is one of the parent chain's accounts we already treat as unlocked. */
    private isDevAccount(address: string): boolean {
        return DEV_ACCOUNTS.includes(normaliseAddress(address));
    }

    /**
     * The accounts `eth_accounts` reports.
     *
     * Anything can send here — the engine impersonates whoever a transaction
     * says it is from — but a client cannot discover that. ethers' `getSigner()`
     * checks this list and refuses with "invalid account" when it is empty, and
     * Hardhat has nothing to put in `signers`. So the answer is the same ten
     * addresses every local chain uses, which is what every tool already expects
     * to find.
     */
    accounts(): string[] {
        return [ ...DEV_ACCOUNTS ];
    }

    /**
     * What to show a person who asks why a transaction failed.
     *
     * Three shapes reach here. `Error(string)` carries its own sentence. A
     * `Panic(uint256)` carries a code the compiler assigns, and the code alone
     * ("0x11") tells nobody anything, so it is named. Anything else is a custom
     * error, which cannot be named without the ABI — that is the explorer's job,
     * and `revertData` is what it needs; the selector is reported so the line is
     * still specific enough to search for.
     */
    private revertReason(exec: { returnValue: Uint8Array; exceptionError?: { error: string } }): string {
        const data = bytesToHex(exec.returnValue);

        // Error(string): the selector, then an offset, a length and the bytes.
        if (data.startsWith("0x08c379a0") && data.length >= 138) {
            try {
                const length = Number.parseInt(data.slice(74, 138), 16);
                const text = Buffer.from(data.slice(138, 138 + length * 2), "hex").toString("utf8");
                if (text) return text;
            } catch {
                // Fall through to the raw error below.
            }
        }

        // Panic(uint256): the compiler's own failures, not the contract's.
        if (data.startsWith("0x4e487b71") && data.length >= 74) {
            const code = data.slice(10, 74).replace(/^0+/, "");
            return PANIC[code] ?? `panic (0x${code || "0"})`;
        }

        // A custom error. Four bytes of selector is all that can be said here.
        if (data.length >= 10 && data !== "0x") {
            return `reverted with custom error ${data.slice(0, 10)}`;
        }

        // No data at all: a bare `revert()`, or the EVM stopping it (out of gas,
        // a bad jump). The EVM's own word for it is the most accurate thing left.
        return exec.exceptionError?.error ?? "reverted without a reason";
    }

    /**
     * A stand-in hash for an unsigned `eth_sendTransaction`, which has no real one.
     *
     * It must be a hash and not the material itself: truncating the material to
     * 32 bytes made two calls from the same sender collide whenever their data
     * only differed past the cutoff, and the second one would then be looked up
     * as the first.
     */
    private hashFor(from: string, nonce: bigint, data: string, value: bigint): string {
        const material = `${from}:${nonce}:${data}:${value}:${this.chain.height}`;
        return bytesToHex(keccak_256(utf8ToBytes(material)));
    }

    private mineBlock(txs: StoredTx[], gasUsed: bigint): void {
        this.revision++;
        const parent = this.chain.latest();
        const number = this.chain.height + 1;
        const timestamp = Math.floor(Date.now() / 1000) + this.timeOffset;
        const hash = bytesToHex(keccak_256(utf8ToBytes(`block:${this.chainId}:${number}:${timestamp}`)));

        const block: StoredBlock = {
            number,
            hash,
            parentHash: parent?.hash ?? "0x" + "0".repeat(64),
            timestamp,
            gasUsed: "0x" + gasUsed.toString(16),
            gasLimit: "0x" + DEFAULT_GAS.toString(16),
            baseFeePerGas: "0x0",
            miner: ANONYMOUS,
            transactions: txs.map((t) => t.hash),
        };
        this.chain.add(block, txs);
        this.overlay.blockNumber = this.chain.length;
    }

    /**
     * Watches for blocks, and returns the way to stop.
     *
     * Announced after the block is complete rather than as it is built: a
     * transaction learns its block hash only once the block exists, and a
     * subscriber told earlier would be handed logs pointing at a block of
     * zeroes — which is exactly the kind of thing an indexer stores forever.
     */
    watch(listener: (block: StoredBlock, txs: StoredTx[]) => void): () => void {
        this.watchers.add(listener);
        return () => { this.watchers.delete(listener); };
    }

    /** Never lets a listener's failure reach the transaction that mined the block. */
    private announce(block: StoredBlock, txs: StoredTx[]): void {
        for (const watcher of this.watchers) {
            try {
                watcher(block, txs);
            } catch (error) {
                console.error("a block watcher threw:", error);
            }
        }
    }

    /** Produces empty blocks, for a contract that counts them. */
    mine(count = 1): number {
        for (let i = 0; i < count; i++) {
            this.mineBlock([], 0n);
            this.announce(this.chain.latest()!, []);
        }
        return this.chain.height;
    }

    increaseTime(seconds: number): number {
        this.timeOffset += seconds;
        this.mineBlock([], 0n);
        this.announce(this.chain.latest()!, []);
        return this.timeOffset;
    }

    impersonate(address: string): void {
        this.impersonated.add(normaliseAddress(address));
    }

    stopImpersonating(address: string): void {
        this.impersonated.delete(normaliseAddress(address));
    }

    setAutoImpersonate(on: boolean): void {
        this.autoImpersonate = on;
    }

    blockNumber(): number {
        return this.chain.height;
    }

    getBlock(id: number | string): StoredBlock | null {
        return this.chain.getBlock(id);
    }

    getTransaction(hash: string): StoredTx | null {
        return this.chain.getTx(hash);
    }

    recentTransactions(limit = 20): StoredTx[] {
        return this.chain.recentTxs(limit);
    }

    // ---- snapshots ----------------------------------------------------------

    /**
     * Snapshots are copies of the overlay, not of the chain.
     *
     * That is only affordable because the overlay is what this environment wrote —
     * kilobytes. On a design that copied state, a snapshot would be a second copy
     * of everything, which is why nobody offers them freely.
     */
    private readonly snapshots = new Map<string, { overlay: Overlay; chain: ReturnType<Chain["export"]>; time: number }>();
    private snapshotSeq = 0;

    snapshot(): string {
        const id = "0x" + (this.snapshotSeq++).toString(16);
        this.snapshots.set(id, {
            overlay: structuredClone(this.overlay),
            chain: structuredClone(this.chain.export()),
            time: this.timeOffset,
        });
        return id;
    }

    async revert(id: string): Promise<boolean> {
        const saved = this.snapshots.get(id);
        if (!saved) return false;

        // Everything taken after this one is gone too, as it is on a real node:
        // they describe a future that no longer happened.
        for (const key of [ ...this.snapshots.keys() ]) {
            if (Number(key) >= Number(id)) this.snapshots.delete(key);
        }

        this.overlay.accounts = structuredClone(saved.overlay.accounts);
        this.overlay.blockNumber = saved.overlay.blockNumber;
        this.timeOffset = saved.time;
        this.chain.rollbackTo(saved.chain.forkHeight + saved.chain.blocks.length);

        // A fresh state manager, not a patched one.
        //
        // Undoing writes in place cannot work: a slot the snapshot never mentioned
        // was being read through to the parent at the time, and there is no value to
        // put back — writing zero would shadow the parent with a lie. Starting over
        // and replaying the overlay restores read-through for exactly the slots that
        // had it. The read cache is lost, which costs some RPC calls on the next
        // reads; a revert is rare and being wrong is not worth avoiding that.
        await this.rebuildState();
        return true;
    }

    /**
     * Moves the fork up to the parent's current head, keeping everything written here.
     *
     * This is nearly free precisely because nothing was copied: the fork is a block
     * tag plus an overlay, so following the head means reading at a newer tag and
     * replaying the same overlay onto it.
     *
     * Two things are worth being clear about. Blocks produced before a sync keep
     * their numbers, which now sit inside the range the parent also covers — this
     * fork's own history wins for those, the way the overlay wins over parent
     * state. And the overlay holds *values*, not operations: a balance you set
     * still reads back as you set it, but a balance some transaction computed from
     * the parent was computed against the older block and is not recalculated.
     */
    async syncToHead(): Promise<{ from: bigint; to: bigint; advanced: boolean }> {
        const from = this.forkBlock;
        const head = BigInt(await rpc<string>(this.rpcUrl, "eth_blockNumber", []));
        if (head <= from || !this.chain.advanceForkTo(Number(head))) {
            return { from, to: from, advanced: false };
        }

        this.forkBlock = head;
        this.overlay.forkBlock = "0x" + head.toString(16);
        this.revision++;
        // Every value the state manager cached was read at the old block, so it
        // has to go with the tag: mixing two heights is how a fork starts
        // answering with state that never existed together.
        await this.rebuildState();
        return { from, to: head, advanced: true };
    }

    /**
     * Changes the chain id this fork answers with.
     *
     * The id is not a label. EIP-155 folds it into every signature, so a wallet
     * that has the old one signs transactions this fork will refuse; and the
     * CHAINID opcode reads it, so a contract that branches on the network sees
     * the change too. Both live in the VM's rules rather than in a field, which
     * is why this rebuilds rather than assigns.
     *
     * Blocks already produced keep the hashes they were given. Nothing is
     * recomputed, because a hash that changes under a receipt someone already
     * holds is worse than one that records the id the chain had at the time.
     */
    async setChainId(next: number): Promise<void> {
        if (!Number.isInteger(next) || next <= 0) {
            throw new Error("A chain id is a positive whole number.");
        }
        if (next === this.chainId) return;
        this.chainId = next;
        this.overlay.chainId = next;
        await this.rebuildState();
    }

    /** Replaces the state manager with a clean one and replays the overlay onto it. */
    private async rebuildState(): Promise<void> {
        this.state = new ForkStateManager({ provider: this.rpcUrl, blockTag: this.forkBlock, cache: this.cache });
        this.state.onUpstreamFetch = this.upstreamFetch;
        this.common = new Common({ chain: { ...Mainnet, chainId: this.chainId } });
        this.vm = await createVM({ common: this.common, stateManager: this.state });
        this.recordWrites();
        await this.reapplyOverlay();
    }

    /** Pushes the overlay back into the state manager, discarding anything else it holds. */
    private async reapplyOverlay(): Promise<void> {
        for (const [ address, account ] of Object.entries(this.overlay.accounts)) {
            const addr = createAddressFromString(address);
            const existing = (await this.state.getAccount(addr)) ?? new Account();
            if (account.balance !== undefined) existing.balance = BigInt(account.balance);
            if (account.nonce !== undefined) existing.nonce = BigInt(account.nonce);
            await this.state.putAccount(addr, existing);
            if (account.code !== undefined) await this.state.putCode(addr, hexToBytes(account.code as `0x${string}`));
            for (const [ slot, value ] of Object.entries(account.storage ?? {})) {
                await this.state.putStorage(addr, hexToBytes(slot as `0x${string}`), hexToBytes(value as `0x${string}`));
            }
        }
    }

    // ---- tracing ------------------------------------------------------------

    /**
     * Runs a call and reports what the EVM did, without keeping any of it.
     *
     * This is the "what if" question: the call executes against current state,
     * inside a checkpoint that is always reverted, so asking it changes nothing.
     */
    async traceCall(
        request: CallRequest, options: TraceOptions = {}, overrides?: StateOverrides,
    ): Promise<{
        trace: Trace;
        gasUsed: string;
        reverted: boolean;
        returnValue: string;
        error?: string;
    }> {
        const stop = attachTracer(this.vm.evm as never, options);
        try {
            const result = await this.call(request, overrides);
            return {
                trace: stop(),
                gasUsed: result.gasUsed,
                reverted: result.reverted,
                returnValue: result.returnValue,
                error: result.error ?? undefined,
            };
        } catch (error) {
            // The tracer has to come off even when the call throws, or it stays
            // attached to this environment for every call that follows.
            stop();
            throw error;
        }
    }

    /**
     * Records a slot's first "before" and its latest "after".
     *
     * Only the first before matters: a transaction that writes the same slot
     * three times changed it once, from what it was to what it ended as.
     */
    private async noteSlot(address: string, slot: string, after: string): Promise<void> {
        const who = normaliseAddress(address);
        const where = normaliseWord(slot);
        const entry = (this.capturing!.storage[who] ??= {});
        if (!(where in entry)) {
            const before = await this.state.getStorage(
                createAddressFromString(who), hexToBytes(where as `0x${string}`),
            );
            entry[where] = { before: normaliseWord(bytesToHex(before)), after: normaliseWord(after) };
        } else {
            entry[where]!.after = normaliseWord(after);
        }
    }

    private async noteAccount(address: Address, next: Account): Promise<void> {
        const who = normaliseAddress(address.toString());
        const entry = this.capturing!.accounts[who];
        if (!entry) {
            const before = (await this.state.getAccount(address)) ?? new Account();
            this.capturing!.accounts[who] = {
                balance: { before: "0x" + before.balance.toString(16), after: "0x" + next.balance.toString(16) },
                nonce: { before: "0x" + before.nonce.toString(16), after: "0x" + next.nonce.toString(16) },
            };
        } else {
            entry.balance.after = "0x" + next.balance.toString(16);
            entry.nonce.after = "0x" + next.nonce.toString(16);
        }
    }

    /**
     * Fills in what each `SLOAD` actually read.
     *
     * The step fires before the opcode runs, so the value is not on the stack
     * yet. It does not need to be: the operations are in order, so a read
     * returns whatever the last write to that slot put there, and failing that
     * the value the slot held before the transaction — which is the diff's
     * `before` for a slot this transaction wrote, and the current value for one
     * it only read, since nothing has changed it since.
     */
    private async resolveReads(trace: Trace, diff: StateDiff): Promise<void> {
        const written = new Map<string, string>();
        const pending: Array<{ op: { slot?: string; value?: string; address: string }; key: string }> = [];

        const walk = (frame: { ops: Array<{ kind: string; address: string; slot?: string; value?: string }>; calls: unknown[] }) => {
            for (const op of frame.ops) {
                if (!op.slot) continue;
                const key = `${normaliseAddress(op.address)}|${normaliseWord(op.slot)}`;
                if (op.kind === "sstore") {
                    written.set(key, op.value!);
                } else if (op.kind === "sload") {
                    const seen = written.get(key);
                    if (seen !== undefined) op.value = seen;
                    else pending.push({ op, key });
                }
            }
            for (const child of frame.calls) walk(child as never);
        };
        if (trace.root) walk(trace.root as never);

        for (const { op, key } of pending) {
            const [ address, slot ] = key.split("|") as [ string, string ];
            const before = diff.storage[address]?.[slot]?.before;
            op.value = before ?? bytesToHex(await this.state.getStorage(
                createAddressFromString(address), hexToBytes(slot as `0x${string}`),
            ));
        }
    }

    /**
     * Contracts this testnet knows it has.
     *
     * Only the ones deployed here, or whose code was replaced with a cheatcode —
     * those are the ones the overlay owns. Everything else on the parent chain
     * is still reachable, but there are millions of them and no list; a fork
     * inherits the chain, not an index of it.
     */
    deployedContracts(): Array<{ address: string; codeSize: number }> {
        return Object.entries(this.overlay.accounts)
            .filter(([ , account ]) => account.code && account.code !== "0x")
            .map(([ address, account ]) => ({
                address,
                codeSize: (account.code!.length - 2) / 2,
            }));
    }

    /**
     * Reads this environment's own usage back.
     *
     * Wired by the manager, which is the only thing that knows what this
     * environment is called and where the totals are kept.
     */
    usageReader: ((days: number) => Promise<unknown>) | null = null;

    async usage(days: number): Promise<unknown> {
        return this.usageReader ? this.usageReader(days) : { days: [], note: "not metered" };
    }

    /** How many blocks and transactions this fork has produced. */
    counts(): { blocks: number; transactions: number } {
        const chain = this.chain.export();
        return { blocks: chain.blocks.length, transactions: chain.txs.length };
    }

    /** What a transaction changed. */
    async getDiff(hash: string): Promise<StateDiff | null> {
        const key = hash.toLowerCase();
        const held = this.diffs.get(key);
        if (held) return held;
        await this.recall(key);
        return this.diffs.get(key) ?? null;
    }

    /** The trace kept from when a transaction ran here. */
    async getTrace(hash: string): Promise<Trace | null> {
        const key = hash.toLowerCase();
        const held = this.traces.get(key);
        if (held) return held;
        await this.recall(key);
        return this.traces.get(key) ?? null;
    }

    /**
     * Brings one archived trace back into memory.
     *
     * Both maps are filled together because a page that shows a trace shows the
     * state it changed beside it, so the second lookup is certain to follow.
     */
    private async recall(key: string): Promise<void> {
        if (!this.archive) return;
        const found = await this.archive.load(key);
        if (!found) return;
        this.traces.set(key, found.trace);
        if (found.diff) this.diffs.set(key, found.diff);
    }

    // ---- tokens -------------------------------------------------------------

    /**
     * Gives an address a token balance, by writing the slot the token keeps it in.
     *
     * There is no standard way to ask a contract where its balances live, so the
     * slot has to be found: for each candidate index the mapping slot is computed,
     * a sentinel written, and `balanceOf` asked whether it noticed. Whichever
     * index makes the contract agree is the one it uses.
     *
     * Both key orders are tried. Solidity hashes `(holder, index)` and Vyper
     * hashes `(index, holder)`, and a faucet that only knows one of them silently
     * fails on half the tokens it is pointed at.
     *
     * Every probe puts the slot back the way it found it, so a search that fails
     * leaves no trace — writing zeroes into twenty unrelated slots would shadow
     * the parent chain with lies that outlive the attempt.
     */
    async setTokenBalance(
        token: string, holder: string, amount: bigint, maxSlots = 32,
    ): Promise<{ slot: string; index: number; layout: "solidity" | "vyper" } | null> {
        const contract = normaliseAddress(token);
        const who = normaliseAddress(holder);
        const balanceOf = "0x70a08231" + who.slice(2).padStart(64, "0");
        const read = async () => {
            const result = await this.call({ to: contract, data: balanceOf });
            return result.reverted || !result.returnValue || result.returnValue === "0x"
                ? null
                : BigInt(result.returnValue);
        };

        let found: { slot: string; index: number; layout: "solidity" | "vyper" } | null = null;

        // The search itself is not a change this environment is making, so none
        // of it — not the sentinel, not putting the slot back — may be recorded.
        this.suppress = true;
        try {
            search:
            for (const layout of [ "solidity", "vyper" ] as const) {
                for (let index = 0; index < maxSlots; index++) {
                    const slot = mappingSlot(who, index, layout);
                    const original = await this.getStorageAt(contract, slot);

                    await this.setStorageAt(contract, slot, word(SENTINEL));
                    const seen = await read();
                    await this.setStorageAt(contract, slot, original);

                    if (seen === SENTINEL) {
                        found = { slot, index, layout };
                        break search;
                    }
                }
            }
        } finally {
            this.suppress = false;
        }

        // Only the answer is a write this environment owns.
        if (found) await this.setStorageAt(contract, found.slot, word(amount));
        return found;
    }

    // ---- logs ---------------------------------------------------------------

    /**
     * Logs from blocks produced here.
     *
     * Blocks below the fork belong to the parent chain and are not served: this
     * environment never saw them, and answering as if it had would be a lie that
     * an indexer would believe.
     */
    newFilter(criteria: Filter["criteria"], kind: Filter["kind"] = "log"): string {
        const id = "0x" + (this.nextFilterId++).toString(16).padStart(32, "0");
        this.filters.set(id, { kind, criteria, cursor: this.chain.height });
        return id;
    }

    /** What has happened since the last poll — and nothing that came before it. */
    getFilterChanges(id: string): unknown[] {
        const filter = this.filters.get(id);
        if (!filter) throw new Error("filter not found");
        const from = filter.cursor + 1;
        const to = this.chain.height;
        filter.cursor = to;
        if (to < from) return [];
        if (filter.kind === "block") {
            const hashes: string[] = [];
            for (let n = from; n <= to; n++) {
                const block = this.chain.getBlock(n);
                if (block) hashes.push(block.hash);
            }
            return hashes;
        }
        return this.getLogs({ ...filter.criteria, fromBlock: from, toBlock: to });
    }

    /** Everything the filter matches, ignoring the cursor. */
    getFilterLogs(id: string): unknown[] {
        const filter = this.filters.get(id);
        if (!filter) throw new Error("filter not found");
        if (filter.kind !== "log") throw new Error("filter is not a log filter");
        return this.getLogs(filter.criteria);
    }

    uninstallFilter(id: string): boolean {
        return this.filters.delete(id);
    }

    getLogs(filter: LogFilter & { fromBlock?: number; toBlock?: number }): Log[] {
        const from = filter.fromBlock ?? 0;
        const to = filter.toBlock ?? Number.MAX_SAFE_INTEGER;

        const out: Log[] = [];
        for (const tx of this.chain.recentTxs(Number.MAX_SAFE_INTEGER).reverse()) {
            if (tx.blockNumber < from || tx.blockNumber > to) continue;
            for (const log of tx.logs) {
                // The same matcher a subscription uses, so backfilling with this
                // and then following with eth_subscribe cannot disagree.
                if (logMatches(log, filter)) out.push(log);
            }
        }
        return out;
    }

    /** For a call the caller wants priced rather than run. */
    async estimateGas(request: CallRequest): Promise<bigint> {
        const result = await this.call(request);
        if (result.reverted) throw new Error(result.error ?? "reverted");
        // The EVM reports what it burned; a caller needs headroom for the difference
        // between a simulated run and a real one.
        return (BigInt(result.gasUsed) * 12n) / 10n + 21_000n;
    }

    /** Reads that this environment has no answer for, and the parent chain does. */
    async passthrough<T>(method: string, params: unknown[]): Promise<T> {
        return rpc<T>(this.rpcUrl, method, params);
    }

    // ---- persistence --------------------------------------------------------

    /**
     * Everything needed to rebuild this environment.
     *
     * It is only the writes, so it stays in kilobytes where a chain dump would be
     * in gigabytes — and restoring it re-reads the parent chain lazily, exactly as
     * the first run did.
     */
    exportOverlay(): Overlay {
        return structuredClone(this.overlay);
    }

    /** What the shared cache has saved. Zero hits means every read is being paid for twice. */
    async cacheStats(): Promise<unknown> {
        return this.cache?.stats() ?? { enabled: false };
    }

    size(): ReturnType<typeof overlaySize> {
        return overlaySize(this.overlay);
    }

    exportChain(): ReturnType<Chain["export"]> {
        return this.chain.export();
    }

    static async restore(
        overlay: Overlay, rpcUrl: string,
        chain?: ReturnType<Chain["export"]>, cache?: UpstreamCache | null,
    ): Promise<Environment> {
        const env = await Environment.create({
            rpcUrl,
            chainId: overlay.chainId,
            forkBlock: BigInt(overlay.forkBlock),
            cache,
        });

        for (const [ address, account ] of Object.entries(overlay.accounts)) {
            if (account.balance !== undefined) await env.setBalance(address, BigInt(account.balance));
            if (account.nonce !== undefined) await env.setNonce(address, BigInt(account.nonce));
            if (account.code !== undefined) await env.setCode(address, account.code);
            for (const [ slot, value ] of Object.entries(account.storage ?? {})) {
                await env.setStorageAt(address, slot, value);
            }
        }

        env.overlay.blockNumber = overlay.blockNumber;
        // The blocks are restored after the state, so a receipt never points at a
        // block whose effects are not in place yet.
        if (chain) {
            const restored = Chain.restore(chain);
            (env as unknown as { chain: Chain }).chain = restored;
        }
        return env;
    }
}

export { Address };
