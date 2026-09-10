/**
 * The JSON-RPC surface.
 *
 * Anything this environment cannot answer is forwarded to the parent chain. That
 * is the same read-through the state manager does, one layer up: a block below
 * the fork, a receipt from last year, a method we have not implemented — the
 * parent has them, and pretending otherwise would make a wallet's history vanish.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@ethereumjs/util";

import type { Environment, StateOverrides } from "./environment.ts";
import { submitVerification, verificationStatus, type VerifyRequest } from "./verify.ts";
import type { StoredBlock, StoredTx } from "./chain.ts";
import type { Log } from "./types.ts";

interface RpcRequest {
    jsonrpc?: string;
    id?: number | string | null;
    method?: string;
    params?: unknown[];
}

const hex = (value: bigint | number): string => "0x" + BigInt(value).toString(16);

/** Where downloaded compilers are kept; beside the overlay database by default. */
const SOLC_DIR = process.env.FORKSTATE_SOLC_DIR ?? "./data/solc";

/** Methods that must never reach the parent chain, because a wrong answer is worse than none. */
const NEVER_FORWARD = new Set([
    "eth_sendTransaction", "eth_sendRawTransaction", "eth_accounts", "eth_chainId", "net_version",
    "eth_newFilter", "eth_newBlockFilter", "eth_getFilterChanges", "eth_getFilterLogs",
    "eth_uninstallFilter", "eth_newPendingTransactionFilter",
    "forkstate_sync", "forkstate_followHead", "forkstate_setTokenBalance", "forkstate_contracts",
    "forkstate_setChainId", "forkstate_verify", "forkstate_verifyStatus",
]);

/**
 * Where a block tag sits in each method's parameters.
 *
 * A forwarded "latest" is the worst bug this server can have, because it looks
 * right: the parent resolves it against its own head, which has moved on since
 * the fork, and the caller gets a real block from a chain they are not on.
 * Asking about the fork point instead makes a forwarded answer true again.
 */
const BLOCK_TAG_AT: Record<string, number> = {
    eth_getBalance: 1, eth_getCode: 1, eth_getTransactionCount: 1, eth_getStorageAt: 2,
    eth_call: 1, eth_getBlockByNumber: 0, eth_getBlockTransactionCountByNumber: 0,
    eth_getTransactionByBlockNumberAndIndex: 0, eth_getUncleCountByBlockNumber: 0,
    eth_getBlockReceipts: 0, eth_feeHistory: 1, eth_getUncleByBlockNumberAndIndex: 0,
};

const MOVING_TAG = new Set([ "latest", "pending", "safe", "finalized" ]);

/** A forwarded call asks about the fork point, never about the parent's head. */
function anchorToFork(env: Environment, method: string, params: unknown[]): unknown[] {
    const at = BLOCK_TAG_AT[method];
    if (at === undefined || !MOVING_TAG.has(String(params[at]))) return params;
    const anchored = [ ...params ];
    anchored[at] = hex(env.forkBlock);
    return anchored;
}

/** keccak256 of an empty uncle list. Some tools check it; zeroes fail that check. */
const EMPTY_UNCLES = "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347";
const ZERO_HASH = "0x" + "0".repeat(64);
const EMPTY_BLOOM = "0x" + "0".repeat(512);

/**
 * The logs bloom, computed rather than left empty.
 *
 * Zeroes are not a neutral placeholder here: a client that pre-filters by bloom
 * reads "no log in this block can match" and stops, so `eth_getLogs` quietly
 * returns nothing and the caller concludes their event never fired. Wrong in the
 * one direction that cannot be noticed.
 */
function bloomFor(logs: Log[]): string {
    const bits = new Uint8Array(256);
    const add = (value: string) => {
        const hash = keccak_256(hexToBytes(value as `0x${string}`));
        // Three 11-bit indices, from the first three byte pairs.
        for (const pair of [ 0, 2, 4 ]) {
            const index = ((hash[pair]! << 8) | hash[pair + 1]!) & 0x7ff;
            bits[255 - (index >> 3)]! |= 1 << (index & 7);
        }
    };
    for (const log of logs) {
        add(log.address);
        for (const topic of log.topics) add(topic);
    }
    return bytesToHex(bits);
}

function blockToRpc(block: StoredBlock, chainId: number, full: boolean, txs: StoredTx[]): unknown {
    return {
        number: hex(block.number),
        hash: block.hash,
        parentHash: block.parentHash,
        timestamp: hex(block.timestamp),
        gasUsed: block.gasUsed,
        gasLimit: block.gasLimit,
        baseFeePerGas: block.baseFeePerGas,
        miner: block.miner,
        difficulty: "0x0",
        totalDifficulty: "0x0",
        size: hex(512),
        extraData: "0x",
        nonce: "0x0000000000000000",

        /*
         * Post-merge this field carries `block.prevrandao`, and Foundry treats it
         * as required: without it `forge create`, `forge script` and `cast send`
         * all fail while reads keep working, because the failure is in
         * deserialising the block rather than in anything the call did.
         */
        mixHash: ZERO_HASH,

        sha3Uncles: EMPTY_UNCLES,
        logsBloom: bloomFor(txs.flatMap((tx) => tx.logs)),
        stateRoot: ZERO_HASH,
        transactionsRoot: ZERO_HASH,
        receiptsRoot: ZERO_HASH,
        uncles: [],

        // Shanghai and Cancun. Clients built for a modern chain read these, and
        // an absent field is not the same to them as an empty one.
        withdrawals: [],
        withdrawalsRoot: ZERO_HASH,
        blobGasUsed: "0x0",
        excessBlobGas: "0x0",
        parentBeaconBlockRoot: ZERO_HASH,

        transactions: full ? txs.map((tx) => txToRpc(tx, chainId, block.hash)) : block.transactions,
    };
}

function txToRpc(tx: StoredTx, chainId: number, blockHash?: string): unknown {
    return {
        hash: tx.hash,
        blockNumber: hex(tx.blockNumber),
        // The block this is actually in. It used to be zeroes, which told every
        // client the transaction belonged to a block that does not exist.
        blockHash: blockHash ?? tx.blockHash ?? ZERO_HASH,
        transactionIndex: hex(tx.transactionIndex),
        from: tx.from,
        to: tx.to,
        value: tx.value,
        input: tx.input,
        nonce: hex(tx.nonce),
        gas: tx.gas,
        gasPrice: tx.gasPrice,
        maxFeePerGas: tx.gasPrice,
        maxPriorityFeePerGas: "0x0",
        chainId: hex(chainId),
        type: "0x0",
        accessList: [],
        // A transaction sent here is authorised by the caller, not by a
        // signature, so there is none to report. `v` still has to be a valid
        // EIP-155 value or clients reject the shape while parsing it.
        v: hex(chainId * 2 + 35),
        r: ZERO_HASH,
        s: ZERO_HASH,
        yParity: "0x0",
    };
}

function receiptToRpc(tx: StoredTx): unknown {
    return {
        transactionHash: tx.hash,
        transactionIndex: hex(tx.transactionIndex),
        blockNumber: hex(tx.blockNumber),
        blockHash: tx.blockHash ?? tx.logs[0]?.blockHash ?? ZERO_HASH,
        from: tx.from,
        to: tx.to,
        cumulativeGasUsed: tx.gasUsed,
        gasUsed: tx.gasUsed,
        effectiveGasPrice: tx.gasPrice,
        contractAddress: tx.contractAddress,
        logs: tx.logs,
        logsBloom: tx.logs.length > 0 ? bloomFor(tx.logs) : EMPTY_BLOOM,
        status: hex(tx.status),
        type: "0x0",
        /*
         * Why it failed, on the receipt itself.
         *
         * Not in the JSON-RPC spec — a receipt there says only 0 or 1 — but a
         * status with no reason is the one thing every explorer has to explain
         * and cannot. Geth exposes `revertReason` and Blockscout reads it, so
         * that is the name used here. Both are absent on a successful receipt,
         * which keeps the usual shape untouched.
         */
        ...(tx.status === 0 ? {
            revertReason: tx.error,
            revertData: tx.revertData ?? null,
        } : {}),
    };
}

/** "latest", "0x1f", 31 — all mean a height here. */
function toHeight(env: Environment, tag: unknown): number {
    if (tag === undefined || tag === null || tag === "latest" || tag === "pending" || tag === "safe" || tag === "finalized") {
        return env.blockNumber();
    }
    if (tag === "earliest") return 0;
    return Number(BigInt(String(tag)));
}

export async function handleRpc(env: Environment, request: RpcRequest): Promise<unknown> {
    const method = String(request.method ?? "");
    const params = (request.params ?? []) as unknown[];
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: request.id ?? null, result });
    const fail = (message: string, code = -32000) =>
        ({ jsonrpc: "2.0", id: request.id ?? null, error: { code, message } });

    try {
        switch (method) {
            // ---- identity
            case "eth_chainId": return reply(hex(env.chainId));
            case "net_version": return reply(String(env.chainId));
            case "web3_clientVersion": return reply("forkstate/0.1.0");
            case "eth_blockNumber": return reply(hex(env.blockNumber()));
            case "eth_accounts": return reply(env.accounts());
            case "net_listening": return reply(true);
            case "net_peerCount": return reply("0x0");
            case "eth_syncing": return reply(false);
            case "eth_mining": return reply(false);
            case "eth_hashrate": return reply("0x0");
            case "eth_coinbase": return reply("0x" + "0".repeat(40));
            case "eth_protocolVersion": return reply("0x41");
            case "eth_blobBaseFee": return reply("0x1");

            // No key ever reaches this process; impersonation is how you act as
            // someone here, and a signature we cannot produce should say so.
            case "eth_sign":
            case "eth_signTypedData":
            case "eth_signTypedData_v4":
            case "eth_signTransaction":
                return fail(`${method}: this node holds no keys — sign in your wallet and use `
                    + `eth_sendRawTransaction, or use anvil_impersonateAccount`, -32601);

            // Subscriptions need a socket to push down, and this server is HTTP.
            case "eth_subscribe":
            case "eth_unsubscribe":
                return fail(`${method} needs a WebSocket connection; poll with eth_newFilter `
                    + `and eth_getFilterChanges instead`, -32601);

            // A proof is a claim about a trie this fork does not build, and the
            // parent's proof would omit everything the overlay has written —
            // a signed statement that the fork's own state does not exist.
            case "eth_getProof":
                return fail("eth_getProof cannot be served by a fork: the parent's proof would not "
                    + "include this environment's writes", -32601);

            // ---- state, through the overlay
            case "eth_getBalance": return reply(hex(await env.getBalance(String(params[0]))));
            case "eth_getTransactionCount": return reply(hex(await env.getNonce(String(params[0]))));
            case "eth_getCode": return reply(await env.getCode(String(params[0])));
            case "eth_getStorageAt": return reply(await env.getStorageAt(String(params[0]), String(params[1])));

            // ---- execution
            case "eth_call": {
                const call = params[0] as Record<string, string>;
                // The third parameter, as Geth defines it: state to pretend is
                // true for this call only.
                const result = await env.call(call, params[2] as StateOverrides | undefined);
                if (result.reverted) return fail(result.error ?? "execution reverted", 3);
                return reply(result.returnValue);
            }
            case "eth_estimateGas": {
                const call = params[0] as Record<string, string>;
                return reply(hex(await env.estimateGas(call)));
            }
            case "eth_sendRawTransaction": {
                const tx = await env.sendRawTransaction(String(params[0]));
                return reply(tx.hash);
            }
            case "eth_sendTransaction": {
                const tx = await env.sendTransaction(params[0] as Record<string, string>);
                return reply(tx.hash);
            }

            // ---- chain reads
            case "eth_getBlockByNumber":
            case "eth_getBlockByHash": {
                const id = method.endsWith("Number") ? toHeight(env, params[0]) : String(params[0]);
                const block = env.getBlock(id);
                if (!block) break;                       // below the fork: the parent's
                const txs = block.transactions.map((h) => env.getTransaction(h)!).filter(Boolean);
                return reply(blockToRpc(block, env.chainId, Boolean(params[1]), txs));
            }
            case "eth_getTransactionByHash": {
                const tx = env.getTransaction(String(params[0]));
                if (!tx) break;
                return reply(txToRpc(tx, env.chainId));
            }
            case "eth_getTransactionReceipt": {
                const tx = env.getTransaction(String(params[0]));
                if (!tx) break;
                return reply(receiptToRpc(tx));
            }
            case "eth_getBlockTransactionCountByNumber":
            case "eth_getBlockTransactionCountByHash": {
                const id = method.endsWith("Number") ? toHeight(env, params[0]) : String(params[0]);
                const block = env.getBlock(id);
                if (!block) break;
                return reply(hex(block.transactions.length));
            }
            case "eth_getTransactionByBlockNumberAndIndex":
            case "eth_getTransactionByBlockHashAndIndex": {
                const id = method.includes("Number") ? toHeight(env, params[0]) : String(params[0]);
                const block = env.getBlock(id);
                if (!block) break;
                const hash = block.transactions[Number(BigInt(String(params[1] ?? "0x0")))];
                const tx = hash ? env.getTransaction(hash) : null;
                return reply(tx ? txToRpc(tx, env.chainId) : null);
            }
            case "eth_getBlockReceipts": {
                const block = env.getBlock(toHeight(env, params[0]));
                if (!block) break;
                return reply(block.transactions
                    .map((h) => env.getTransaction(h))
                    .filter((tx): tx is StoredTx => Boolean(tx))
                    .map(receiptToRpc));
            }
            // Nothing here produces uncles, and a forwarded count would be the
            // parent's block rather than ours.
            case "eth_getUncleCountByBlockNumber":
            case "eth_getUncleCountByBlockHash": {
                const id = method.endsWith("Number") ? toHeight(env, params[0]) : String(params[0]);
                if (!env.getBlock(id)) break;
                return reply("0x0");
            }

            case "eth_getLogs": {
                const filter = (params[0] ?? {}) as Record<string, unknown>;
                return reply(env.getLogs({
                    fromBlock: filter.fromBlock === undefined ? undefined : toHeight(env, filter.fromBlock),
                    toBlock: filter.toBlock === undefined ? undefined : toHeight(env, filter.toBlock),
                    address: filter.address as string | string[] | undefined,
                    topics: filter.topics as (string | null)[] | undefined,
                }));
            }

            // ---- filters. A filter made on the parent watches the parent, so a
            // dapp polling one would see mainnet's events and none of its own.
            case "eth_newFilter": {
                const filter = (params[0] ?? {}) as Record<string, unknown>;
                return reply(env.newFilter({
                    address: filter.address as string | string[] | undefined,
                    topics: filter.topics as (string | null)[] | undefined,
                    fromBlock: filter.fromBlock === undefined ? undefined : toHeight(env, filter.fromBlock),
                    toBlock: filter.toBlock === undefined ? undefined : toHeight(env, filter.toBlock),
                }));
            }
            case "eth_newBlockFilter": return reply(env.newFilter({}, "block"));
            case "eth_getFilterChanges": return reply(env.getFilterChanges(String(params[0])));
            case "eth_getFilterLogs": return reply(env.getFilterLogs(String(params[0])));
            case "eth_uninstallFilter": return reply(env.uninstallFilter(String(params[0])));
            case "eth_newPendingTransactionFilter":
                // Nothing is ever pending here: a transaction is mined as it arrives.
                return reply(env.newFilter({}, "block"));

            // ---- fees. A devnet is free; pretending otherwise only breaks wallets.
            case "eth_gasPrice": return reply("0x0");
            case "eth_maxPriorityFeePerGas": return reply("0x0");
            case "eth_feeHistory": {
                const count = Number(BigInt(String(params[0] ?? "0x1")));
                const newest = toHeight(env, params[1]);
                const oldest = Math.max(0, newest - count + 1);
                const zeros = (n: number) => Array.from({ length: n }, () => "0x0");
                return reply({
                    oldestBlock: hex(oldest),
                    // One more base fee than blocks: the extra is the next block's.
                    baseFeePerGas: zeros(newest - oldest + 2),
                    gasUsedRatio: Array.from({ length: newest - oldest + 1 }, () => 0),
                    reward: ((params[2] as number[]) ?? []).length
                        ? Array.from({ length: newest - oldest + 1 }, () => zeros((params[2] as number[]).length))
                        : undefined,
                });
            }

            // ---- cheatcodes
            case "anvil_setBalance":
            case "tenderly_setBalance":
                await env.setBalance(String(params[0]), BigInt(String(params[1])));
                return reply(null);
            case "anvil_setNonce":
                await env.setNonce(String(params[0]), BigInt(String(params[1])));
                return reply(null);
            case "anvil_setCode":
                await env.setCode(String(params[0]), String(params[1]));
                return reply(null);
            case "anvil_setStorageAt":
            case "tenderly_setStorageAt":
                await env.setStorageAt(String(params[0]), String(params[1]), String(params[2]));
                return reply(true);
            case "anvil_impersonateAccount":
                env.impersonate(String(params[0]));
                return reply(null);
            case "anvil_stopImpersonatingAccount":
                env.stopImpersonating(String(params[0]));
                return reply(null);
            case "anvil_autoImpersonateAccount":
                env.setAutoImpersonate(Boolean(params[0]));
                return reply(null);
            case "anvil_mine":
            case "evm_mine":
                return reply(hex(env.mine(params[0] ? Number(BigInt(String(params[0]))) : 1)));
            case "evm_increaseTime":
                return reply(env.increaseTime(Number(params[0])));
            case "evm_snapshot":
                return reply(env.snapshot());
            case "evm_revert":
                return reply(await env.revert(String(params[0])));

            // ---- tracing
            case "debug_traceCall": {
                const options = (params[2] ?? params[1] ?? {}) as Record<string, unknown>;
                const config = (options.tracerConfig ?? options) as Record<string, unknown>;
                /*
                 * A named set of opcodes, or all of them.
                 *
                 * Filtering here rather than in the caller is what lets the limit
                 * mean "this many of the ones you asked for" — a swap is tens of
                 * thousands of steps and almost all of them are the EVM shuffling
                 * its own stack.
                 */
                const SETS: Record<string, RegExp> = {
                    relevant: /^(SLOAD|SSTORE|TLOAD|TSTORE|CALL|STATICCALL|DELEGATECALL|CALLCODE|CREATE2?|LOG[0-4]|RETURN|REVERT|STOP|SELFDESTRUCT|INVALID|BALANCE|EXTCODESIZE|EXTCODEHASH|EXTCODECOPY|SELFBALANCE)$/,
                    storage: /^(SLOAD|SSTORE|TLOAD|TSTORE)$/,
                    calls: /^(CALL|STATICCALL|DELEGATECALL|CALLCODE|CREATE2?)$/,
                    logs: /^LOG[0-4]$/,
                    memory: /^(MSTORE8?|MLOAD|MCOPY|CALLDATACOPY|CODECOPY|RETURNDATACOPY)$/,
                };
                const set = typeof config.opcodes === "string" ? SETS[config.opcodes] : undefined;

                const traced = await env.traceCall(params[0] as Record<string, string>, {
                    only: set,
                    // Opcode entries are opt-in: a single swap is tens of thousands
                    // of them, and returning that by default makes the endpoint
                    // useless for the question people usually have.
                    structLogs: options.tracer === "structLogger" || config.structLogs === true,
                    includeStack: config.disableStack !== true && config.withStack === true,
                    includeMemory: config.enableMemory === true || config.withMemory === true,
                    maxStructLogs: config.limit === undefined ? undefined : Number(config.limit),
                }, options.stateOverrides as StateOverrides | undefined);
                return reply({
                    gas: traced.gasUsed,
                    failed: traced.reverted,
                    returnValue: traced.returnValue,
                    error: traced.error,
                    callTree: traced.trace.root,
                    structLogs: traced.trace.structLogs,
                    truncated: traced.trace.truncated,
                });
            }
            case "debug_traceTransaction": {
                const trace = await env.getTrace(String(params[0]));
                const tx = env.getTransaction(String(params[0]));
                if (!trace || !tx) break;   // before the fork: the parent's to answer
                const diff = await env.getDiff(String(params[0]));
                return reply({
                    gas: tx.gasUsed,
                    failed: tx.status === 0,
                    returnValue: "0x",
                    error: tx.error ?? undefined,
                    callTree: trace.root,
                    // Kept from when it ran, so there are no opcode entries here.
                    // `debug_traceCall` produces those against current state.
                    structLogs: [],
                    truncated: false,
                    stateDiff: diff,
                });
            }

            // ---- this environment, described
            case "forkstate_overlay": return reply(env.exportOverlay());
            /*
             * What this environment has cost.
             *
             * Requests and misses, per day. The miss is the number that matters:
             * a warm call is answered from the shared cache in milliseconds and
             * costs nothing, while a miss is a paid request to the parent chain.
             */
            case "forkstate_usage": {
                const days = params[0] === undefined ? 30 : Math.min(Number(params[0]), 365);
                return reply(await env.usage(days));
            }
            case "forkstate_size": return reply(env.size());
            case "forkstate_cache": return reply(await env.cacheStats());
            case "forkstate_info": return reply({
                chainId: env.chainId,
                forkBlock: hex(env.forkBlock),
                blockNumber: env.blockNumber(),
                followsHead: env.followsHead,
                size: env.size(),
                /*
                 * How much this fork has produced.
                 *
                 * Here because the alternative is asking for every block to count
                 * them, and a page that wants only a number should not have to
                 * fetch the whole chain to get it.
                 */
                counts: env.counts(),
            });
            // Pull this fork up to the parent's current head, keeping its writes.
            case "forkstate_sync": {
                const moved = await env.syncToHead();
                return reply({ from: hex(moved.from), to: hex(moved.to), advanced: moved.advanced });
            }
            // Give an address a token balance by finding the slot the token uses.
            case "forkstate_setTokenBalance": {
                const token = String(params[0]);

                /*
                 * Whether there is a contract there at all, before blaming its
                 * layout.
                 *
                 * The search fails the same way for a token with an unusual
                 * layout and for an address that is not a token — an ordinary
                 * account, or the holder typed into the wrong box, which is the
                 * likelier of the two. Saying "its layout could not be probed"
                 * about an address with no code sends people looking at the
                 * token when the problem is the address.
                 */
                if (await env.getCode(token) === "0x") {
                    return fail(
                        `There is no contract at ${token} on this fork, so it cannot be a token. `
                        + "Check the address — the token and the holder are easy to swap.",
                    );
                }

                const found = await env.setTokenBalance(
                    token, String(params[1]), BigInt(String(params[2])),
                );
                if (!found) {
                    return fail(
                        `Could not find where ${token} keeps balances. It may use a layout this `
                        + "does not probe, or be a proxy that stores them elsewhere.",
                    );
                }
                return reply(found);
            }
            // Contracts the overlay owns: deployed here, or code set by a cheatcode.
            case "forkstate_contracts": return reply(env.deployedContracts());
            case "forkstate_followHead": {
                env.followsHead = params[0] === undefined ? true : Boolean(params[0]);
                return reply(env.followsHead);
            }
            /*
             * Verification, submitted and then polled — Etherscan's shape,
             * because that is the one `forge verify-contract` speaks.
             *
             * The compile happens in another process and can take seconds, so
             * this answers with the guid immediately rather than holding the
             * connection open for it.
             */
            case "forkstate_verify": {
                const request = params[0] as VerifyRequest;
                if (!request?.address) return fail("A verification needs an address.");
                const code = await env.getCode(request.address);
                return reply({ guid: submitVerification(request, code, SOLC_DIR) });
            }
            case "forkstate_verifyStatus": {
                const state = verificationStatus(String(params[0]));
                if (!state) return fail("No such verification. It may have expired.");
                return reply(state);
            }
            // The chain id a wallet and a contract both see. Rebuilds the VM,
            // because EIP-155 and the CHAINID opcode read it from the rules.
            case "forkstate_setChainId": {
                await env.setChainId(Number(params[0]));
                return reply(hex(env.chainId));
            }

            default:
                if (NEVER_FORWARD.has(method)) return fail(`${method} is not supported here`, -32601);
                break;
        }

        // Everything else is the parent chain's to answer — about the fork point.
        return reply(await env.passthrough(method, anchorToFork(env, method, params)));
    } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
    }
}
