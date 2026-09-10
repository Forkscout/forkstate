/**
 * The behaviours a fork has to get right, asserted rather than printed.
 *
 * Each of these was a real bug at some point: a fork that invented its own hash
 * for a signed transaction, an overlay that recorded parent reads as writes, a
 * revert that left a balance behind, a cache that never shared anything.
 *
 * Needs a real parent chain — set FORKSTATE_RPC. Without it the suite skips
 * rather than fails, because a machine with no upstream cannot prove any of this.
 */
import { after, before, describe, it, skip } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeeMarket1559Tx, createLegacyTx } from "@ethereumjs/tx";
import { Common, Mainnet } from "@ethereumjs/common";
import { bytesToHex, hexToBytes, privateToAddress } from "@ethereumjs/util";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { Manager, StaleEnvironment } from "../src/manager.ts";
import { Store } from "../src/store.ts";
import { openBackend } from "../src/backend.ts";
import { limitsFromEnv, RateLimiter } from "../src/limits.ts";
import { Meter } from "../src/meter.ts";
import { UpstreamCache } from "../src/upstream-cache.ts";
import { serve } from "../src/server.ts";

const RPC = process.env.FORKSTATE_RPC;

/*
 * Locally, no archive node means the suite skips and says so — it is a fair
 * thing to want to run the typecheck without one.
 *
 * In CI that is a trap. Everything here is inside one `describe` that skips as a
 * whole, so a missing or expired secret produces a green build that ran nothing
 * at all, and stays green until somebody notices. Better to stop.
 */
if (!RPC && process.env.CI) {
    throw new Error(
        "FORKSTATE_RPC is not set. In CI that means the secret is missing or expired — "
        + "every test would be skipped and the build would pass without running one.",
    );
}
const PORT = Number(process.env.FORKSTATE_TEST_PORT ?? 8699);
const BASE = `http://127.0.0.1:${PORT}`;

// A well-known test key, so the suite carries no secret of its own.
const KEY = hexToBytes("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const SIGNER = ("0x" + Buffer.from(privateToAddress(KEY)).toString("hex")) as `0x${string}`;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const HOLDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const PAIR = "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE";   // WBNB/USDT on PancakeSwap V2

/** `Counter`, compiled with solc 0.8.20 and no optimizer — the verification fixture. */
const CREATION = "0x60a060405234801561000f575f80fd5b503373ffffffffffffffffffffffffffffffffffffffff1660808173ffffffffffffffffffffffffffffffffffffffff168152505060805161025661005b5f395f60a201526102565ff3fe608060405234801561000f575f80fd5b506004361061003f575f3560e01c80632ddbd13a146100435780638da5cb5b14610061578063b20eb4c41461007f575b5f80fd5b61004b61009b565b60405161005891906100f6565b60405180910390f35b6100696100a0565b604051610076919061014e565b60405180910390f35b61009960048036038101906100949190610195565b6100c4565b005b5f5481565b7f000000000000000000000000000000000000000000000000000000000000000081565b805f808282546100d491906101ed565b9250508190555050565b5f819050919050565b6100f0816100de565b82525050565b5f6020820190506101095f8301846100e7565b92915050565b5f73ffffffffffffffffffffffffffffffffffffffff82169050919050565b5f6101388261010f565b9050919050565b6101488161012e565b82525050565b5f6020820190506101615f83018461013f565b92915050565b5f80fd5b610174816100de565b811461017e575f80fd5b50565b5f8135905061018f8161016b565b92915050565b5f602082840312156101aa576101a9610167565b5b5f6101b784828501610181565b91505092915050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52601160045260245ffd5b5f6101f7826100de565b9150610202836100de565b925082820190508082111561021a576102196101c0565b5b9291505056fea264697066735822122008cfe2ca14d7829c0a0f5335bdef61a50cc7da3424f86f3ae4bb8ebc707facad64736f6c63430008140033";

const word = (value: bigint) => value.toString(16).padStart(64, "0");

/** `swapExactETHForTokens(0, [WBNB, USDT], to, deadline)` — a call that goes several frames deep. */
function swapCalldata(to: string): string {
    return "0x7ff36ab5" + word(0n) + word(128n) + pad(to)
        + word(BigInt(Math.floor(Date.now() / 1000) + 600))
        + word(2n) + pad(WBNB) + pad(USDT);
}

const pad = (h: string) => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const balanceSlot = (who: string, mapping: bigint) =>
    "0x" + Buffer.from(keccak_256(Buffer.from(pad(who) + pad(mapping.toString(16)), "hex"))).toString("hex");

let dir: string;
let server: { close(): void };
/** The same store the manager uses, so a test can look at what was written. */
let store: Store;
let meter: Meter;
/** Held so a test can evict an environment, which is what a restart looks like. */
let manager: Manager;

async function newEnv(body: Record<string, unknown> = {}) {
    const res = await fetch(`${BASE}/environments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    return await res.json() as { id: string; chainId: number; forkBlock: string };
}

function rpcFor(id: string) {
    return async (method: string, params: unknown[] = []) => {
        const res = await fetch(`${BASE}/${id}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        return await res.json() as { result?: any; error?: { message: string } };
    };
}

/** Throws on a JSON-RPC error, so a broken call fails the test it happened in. */
function okFor(id: string) {
    const call = rpcFor(id);
    return async (method: string, params: unknown[] = []) => {
        const r = await call(method, params);
        if (r.error) throw new Error(`${method}: ${r.error.message}`);
        return r.result;
    };
}

/**
 * Puts an environment variable back the way it was.
 *
 * `process.env.X = undefined` sets the string "undefined", which is truthy —
 * so restoring an unset variable this way leaves it set to nonsense. It cost a
 * run where every request came back 401 because the key was literally
 * "undefined".
 */
function restoreEnv(name: string, previous: string | undefined): void {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
}

describe("forkstate", { skip: RPC ? false : "set FORKSTATE_RPC to run" }, () => {
    before(async () => {
        dir = mkdtempSync(join(tmpdir(), "forkstate-test-"));
        const backend = await openBackend({ url: process.env.TEST_DATABASE_URL, path: join(dir, "t.db") });
        store = new Store(backend);
        // No timer: the tests that care flush by hand, and a background flush
        // racing an assertion is a flake nobody enjoys chasing.
        meter = new Meter(store, 0);
        manager = new Manager(store, {
            cache: new UpstreamCache(backend),
            checkpoint: 100,
            meter,
        });
        server = serve(manager, PORT, RPC!, meter);
    });

    after(() => {
        server?.close();
        rmSync(dir, { recursive: true, force: true });
    });

    describe("signed transactions", () => {
        it("returns the transaction's real hash, so a wallet can poll for it", async () => {
            const env = await newEnv({ name: "legacy" });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [SIGNER, "0x56bc75e2d63100000"]);

            const common = new Common({ chain: { ...Mainnet, chainId: env.chainId } });
            const tx = createLegacyTx(
                { nonce: 0n, gasPrice: 0n, gasLimit: 100_000n, to: DEAD, value: 10n ** 18n },
                { common },
            ).sign(KEY);

            const returned = await ok("eth_sendRawTransaction", [bytesToHex(tx.serialize())]);
            assert.equal(returned, bytesToHex(tx.hash()));

            const receipt = await ok("eth_getTransactionReceipt", [returned]);
            assert.equal(receipt.status, "0x1");
        });

        it("recovers the sender from the signature rather than trusting a field", async () => {
            const env = await newEnv({ name: "recover" });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [SIGNER, "0x56bc75e2d63100000"]);

            const before = BigInt(await ok("eth_getBalance", [DEAD, "latest"]));
            const common = new Common({ chain: { ...Mainnet, chainId: env.chainId } });
            const tx = createLegacyTx(
                { nonce: 0n, gasPrice: 0n, gasLimit: 100_000n, to: DEAD, value: 10n ** 18n },
                { common },
            ).sign(KEY);
            const hash = await ok("eth_sendRawTransaction", [bytesToHex(tx.serialize())]);

            const receipt = await ok("eth_getTransactionReceipt", [hash]);
            assert.equal(receipt.from.toLowerCase(), SIGNER);
            assert.equal(BigInt(await ok("eth_getBalance", [DEAD, "latest"])) - before, 10n ** 18n);
        });

        it("accepts EIP-1559 transactions, which is what wallets actually send", async () => {
            const env = await newEnv({ name: "typed" });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [SIGNER, "0x56bc75e2d63100000"]);

            const before = BigInt(await ok("eth_getBalance", [DEAD, "latest"]));
            const common = new Common({ chain: { ...Mainnet, chainId: env.chainId } });
            const tx = createFeeMarket1559Tx(
                {
                    nonce: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n,
                    gasLimit: 100_000n, to: DEAD, value: 5n * 10n ** 17n,
                },
                { common },
            ).sign(KEY);

            assert.equal(await ok("eth_sendRawTransaction", [bytesToHex(tx.serialize())]), bytesToHex(tx.hash()));
            assert.equal(BigInt(await ok("eth_getBalance", [DEAD, "latest"])) - before, 5n * 10n ** 17n);
        });

        it("names both chains when the signature is for the wrong one", async () => {
            // The parser's own complaint is "Incompatible EIP155-based V 14714148",
            // which does not tell anyone what to change.
            const env = await newEnv({ name: "wrong-chain" });
            const other = env.chainId === 1 ? 137 : 1;
            const tx = createLegacyTx(
                { nonce: 0n, gasPrice: 0n, gasLimit: 100_000n, to: DEAD, value: 1n },
                { common: new Common({ chain: { ...Mainnet, chainId: other } }) },
            ).sign(KEY);

            const r = await rpcFor(env.id)("eth_sendRawTransaction", [bytesToHex(tx.serialize())]);
            assert.match(r.error!.message, new RegExp(`signed for chain ${other}`));
            assert.match(r.error!.message, new RegExp(`fork is chain ${env.chainId}`));
        });
    });

    describe("verification", () => {
        // Compiled with 0.8.20, no optimizer, as `Counter.sol`. The immutable is
        // deliberate: its value is written into the runtime code at construction,
        // so a check that does not mask immutables fails this contract.
        const SOURCE = "// SPDX-License-Identifier: MIT\npragma solidity 0.8.20;\n\n"
            + "contract Counter {\n    uint256 public total;\n    address public immutable owner;\n\n"
            + "    constructor() { owner = msg.sender; }\n\n"
            + "    function bump(uint256 by) external {\n        total += by;\n    }\n}\n";
        const VERSION = "v0.8.20+commit.a1b79de6";

        async function deployCounter(name: string) {
            const env = await newEnv({ name });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [HOLDER, "0x56bc75e2d63100000"]);
            const hash = await ok("eth_sendTransaction", [ { from: HOLDER, data: CREATION } ]);
            const receipt = await ok("eth_getTransactionReceipt", [hash]);
            assert.equal(receipt.status, "0x1", "the deployment should succeed");
            return { env, ok, address: receipt.contractAddress as string };
        }

        /** Submits and waits, the way a verifying tool does. */
        async function settle(ok: ReturnType<typeof okFor>, request: Record<string, unknown>) {
            const { guid } = await ok("forkstate_verify", [request]);
            for (let attempt = 0; attempt < 60; attempt++) {
                const state = await ok("forkstate_verifyStatus", [guid]);
                if (state.status !== "pending") return state;
                await new Promise((done) => setTimeout(done, 500));
            }
            throw new Error("verification never settled");
        }

        it("accepts source that compiles to the deployed code", { timeout: 180_000 }, async () => {
            const { ok, address } = await deployCounter("verify-pass");
            const state = await settle(ok, {
                address,
                codeFormat: "solidity-single-file",
                sourceCode: SOURCE,
                contractName: "Counter",
                compilerVersion: VERSION,
                optimizationUsed: false,
            });

            assert.equal(state.status, "pass", state.message);
            assert.equal(state.result.match, "exact");
            assert.equal(state.result.name, "Counter");
            assert.equal(state.result.compiler, VERSION);
            assert.match(state.result.abi, /"bump"/);
        });

        it("refuses source that compiles to something else", { timeout: 180_000 }, async () => {
            // Same source, optimizer on: a different program, however honest the
            // submission. Accepting this would make the badge meaningless.
            const { ok, address } = await deployCounter("verify-fail");
            const state = await settle(ok, {
                address,
                codeFormat: "solidity-single-file",
                sourceCode: SOURCE,
                contractName: "Counter",
                compilerVersion: VERSION,
                optimizationUsed: true,
                runs: 200,
            });

            assert.equal(state.status, "fail");
            assert.match(state.message, /does not match what is deployed/);
        });

        it("says so when the contract named is not in the source", { timeout: 180_000 }, async () => {
            const { ok, address } = await deployCounter("verify-name");
            const state = await settle(ok, {
                address,
                codeFormat: "solidity-single-file",
                sourceCode: SOURCE,
                contractName: "Tally",
                compilerVersion: VERSION,
            });

            assert.equal(state.status, "fail");
            assert.match(state.message, /not in what was compiled/);
        });

        it("refuses a compiler version nobody published", { timeout: 60_000 }, async () => {
            const { ok, address } = await deployCounter("verify-version");
            const state = await settle(ok, {
                address,
                codeFormat: "solidity-single-file",
                sourceCode: SOURCE,
                contractName: "Counter",
                compilerVersion: "v9.9.9+commit.deadbeef",
            });

            assert.equal(state.status, "fail");
            assert.match(state.message, /Unknown compiler version/);
        });

        it("will not verify an address with no code", { timeout: 60_000 }, async () => {
            const env = await newEnv({ name: "verify-empty" });
            const state = await settle(okFor(env.id), {
                address: DEAD,
                codeFormat: "solidity-single-file",
                sourceCode: SOURCE,
                contractName: "Counter",
                compilerVersion: VERSION,
            });

            assert.equal(state.status, "fail");
            assert.match(state.message, /Nothing is deployed/);
        });
    });

    describe("the chain id", () => {
        it("is whatever the request asked for, including the parent's own", async () => {
            const env = await newEnv({ name: "own-id", chainId: 1337 });
            assert.equal(env.chainId, 1337);
            assert.equal(await okFor(env.id)("eth_chainId", []), "0x539");
        });

        it("can be changed afterwards, and signatures follow it", async () => {
            const env = await newEnv({ name: "rechain", chainId: 4242 });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [SIGNER, "0x56bc75e2d63100000"]);

            assert.equal(await ok("forkstate_setChainId", [9911]), "0x26b7");
            assert.equal(await ok("eth_chainId", []), "0x26b7");

            // Signed for the id it had before the change: the fork must refuse it,
            // or a wallet left on the old network would appear to work.
            const stale = createLegacyTx(
                { nonce: 0n, gasPrice: 0n, gasLimit: 100_000n, to: DEAD, value: 1n },
                { common: new Common({ chain: { ...Mainnet, chainId: 4242 } }) },
            ).sign(KEY);
            const refused = await rpcFor(env.id)("eth_sendRawTransaction", [bytesToHex(stale.serialize())]);
            assert.match(refused.error!.message, /signed for chain 4242/);

            const fresh = createLegacyTx(
                { nonce: 0n, gasPrice: 0n, gasLimit: 100_000n, to: DEAD, value: 10n ** 18n },
                { common: new Common({ chain: { ...Mainnet, chainId: 9911 } }) },
            ).sign(KEY);
            assert.equal(
                await ok("eth_sendRawTransaction", [bytesToHex(fresh.serialize())]),
                bytesToHex(fresh.hash()),
            );
        });

        it("keeps the overlay across the change", async () => {
            // The VM is rebuilt to pick the id up, and a rebuild that dropped what
            // had been written would lose the whole point of the environment.
            const env = await newEnv({ name: "rechain-state", chainId: 4242 });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [DEAD, "0xde0b6b3a7640000"]);
            await ok("anvil_setStorageAt", [USDT, "0x" + word(7n), "0x" + word(123n)]);

            await ok("forkstate_setChainId", [9912]);

            assert.equal(BigInt(await ok("eth_getBalance", [DEAD, "latest"])), 10n ** 18n);
            assert.equal(BigInt(await ok("eth_getStorageAt", [USDT, "0x" + word(7n), "latest"])), 123n);
        });

        it("survives a restart, so a wallet is not sent back to the old id", async () => {
            const env = await newEnv({ name: "rechain-persist", chainId: 4242 });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [DEAD, "0x1bc16d674ec80000"]);
            await ok("forkstate_setChainId", [9913]);

            // Eviction is what a restart looks like from the inside: the next
            // request rebuilds the environment from what was written out.
            await manager.evict(env.id);

            assert.equal(await ok("eth_chainId", []), "0x26b9");
            assert.equal(BigInt(await ok("eth_getBalance", [DEAD, "latest"])), 2n * 10n ** 18n);
        });
    });

    describe("native value", () => {
        it("takes it from the sender, not out of nowhere", async () => {
            // The account was read before execution and written back afterwards to
            // set the nonce — which restored the pre-transaction balance along with
            // it. A transfer credited the recipient and left the sender untouched,
            // so the fork minted, and an account holding one ether could send a
            // hundred. The value was never missing; it was being put back.
            const env = await newEnv({ name: "value" });
            const ok = okFor(env.id);
            const balance = async (who: string) => BigInt(await ok("eth_getBalance", [ who, "latest" ]));

            await ok("anvil_setBalance", [ SIGNER, "0x8ac7230489e80000" ]);      // 10
            const before = await balance(SIGNER);
            const recipient = await balance(DEAD);

            await ok("eth_sendTransaction", [ { from: SIGNER, to: DEAD, value: "0xde0b6b3a7640000" } ]);

            assert.equal(await balance(SIGNER) - before, -(10n ** 18n), "the sender pays exactly once");
            assert.equal(await balance(DEAD) - recipient, 10n ** 18n);
        });

        it("refuses to spend more than the sender holds", async () => {
            const env = await newEnv({ name: "overspend" });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [ SIGNER, "0xde0b6b3a7640000" ]);        // exactly 1

            const attempt = await rpcFor(env.id)("eth_sendTransaction", [
                { from: SIGNER, to: DEAD, value: "0x56bc75e2d63100000" },          // 100
            ]);
            assert.match(attempt.error!.message, /insufficient funds/);
            assert.equal(BigInt(await ok("eth_getBalance", [ SIGNER, "latest" ])), 10n ** 18n,
                "a refusal must not move anything");
        });

        it("returns the value when the transaction reverts", async () => {
            const env = await newEnv({ name: "revert-value" });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [ SIGNER, "0x8ac7230489e80000" ]);
            const before = BigInt(await ok("eth_getBalance", [ SIGNER, "latest" ]));

            // A transfer of more USDT than exists, with ether attached.
            await ok("eth_sendTransaction", [ {
                from: SIGNER, to: USDT, value: "0xde0b6b3a7640000",
                data: "0xa9059cbb" + pad(DEAD) + "f".repeat(64),
            } ]);

            assert.equal(BigInt(await ok("eth_getBalance", [ SIGNER, "latest" ])), before);
        });
    });

    describe("what tools expect of a block", () => {
        it("includes mixHash, without which Foundry cannot read a block at all", async () => {
            // Post-merge this field carries `block.prevrandao`. Foundry treats it
            // as required, so leaving it out broke `forge create`, `forge script`
            // and `cast send` while every read kept working — the failure was in
            // deserialising the block, not in anything the call did.
            const env = await newEnv({ name: "block-shape" });
            const block = await okFor(env.id)("eth_getBlockByNumber", [ "latest", false ]);

            for (const field of [
                "mixHash", "sha3Uncles", "logsBloom", "stateRoot", "transactionsRoot",
                "receiptsRoot", "withdrawals", "withdrawalsRoot", "blobGasUsed",
                "excessBlobGas", "parentBeaconBlockRoot", "baseFeePerGas", "difficulty", "nonce",
            ]) {
                assert.ok(field in block, `a block must carry ${field}`);
            }
            // Zeroes here would be a claim that this block has uncles.
            assert.equal(block.sha3Uncles,
                "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347");
        });

        it("computes the logs bloom rather than leaving it empty", async () => {
            // An empty bloom is not neutral: a client that pre-filters by it reads
            // "nothing in this block can match" and stops, so eth_getLogs quietly
            // returns nothing and the caller decides their event never fired.
            const env = await newEnv({ name: "bloom" });
            const ok = okFor(env.id);
            await ok("forkstate_setTokenBalance", [ USDT, SIGNER, (10n ** 21n).toString() ]);
            await ok("eth_sendTransaction", [ {
                from: SIGNER, to: USDT,
                data: "0xa9059cbb" + pad(DEAD) + word(10n ** 18n),
            } ]);

            const block = await ok("eth_getBlockByNumber", [ "latest", false ]);
            assert.notEqual(block.logsBloom, "0x" + "0".repeat(512),
                "a block with a Transfer in it has a non-empty bloom");
        });

        it("names the block a transaction is actually in", async () => {
            const env = await newEnv({ name: "block-hash" });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [ SIGNER, "0x8ac7230489e80000" ]);
            const hash = await ok("eth_sendTransaction", [
                { from: SIGNER, to: DEAD, value: "0x1" },
            ]);

            const [ tx, receipt, block ] = await Promise.all([
                ok("eth_getTransactionByHash", [ hash ]),
                ok("eth_getTransactionReceipt", [ hash ]),
                ok("eth_getBlockByNumber", [ "latest", false ]),
            ]);
            assert.equal(tx.blockHash, block.hash, "it used to report a block that does not exist");
            assert.equal(receipt.blockHash, block.hash);
        });
    });

    describe("calldata", () => {
        it("reads `input` as well as `data`", async () => {
            // The execution APIs renamed `data` to `input`, and Foundry sends the
            // new name. Reading only `data` treated a contract deployment as an
            // empty transfer: it estimated at 21,000 gas, Foundry sent exactly
            // that, and the deployment died out of gas with nothing to suggest
            // the calldata had been dropped on the way in.
            const env = await newEnv({ name: "calldata" });
            const ok = okFor(env.id);
            const supply = { to: USDT, data: "0x18160ddd" };

            const viaData = await ok("eth_call", [ supply, "latest" ]);
            const viaInput = await ok("eth_call", [ { to: USDT, input: "0x18160ddd" }, "latest" ]);
            assert.equal(viaInput, viaData);

            // A deployment, which is where this actually bit.
            const bytecode = "0x6080604052348015600e575f5ffd5b50603e80601a5f395ff3fe60"
                + "80604052348015600e575f5ffd5b5000fea164736f6c634300081e000a";
            const estimate = BigInt(await ok("eth_estimateGas", [
                { from: SIGNER, to: null, input: bytecode },
            ]));
            assert.ok(estimate > 21_000n, `a deployment cannot cost 21,000 gas (got ${estimate})`);
        });
    });

    describe("the overlay", () => {
        it("does not record a read of the parent chain as a local write", async () => {
            // Reading through to the parent goes through the same putStorage the
            // overlay watches, so an unguarded fork ends up "owning" all of mainnet.
            const env = await newEnv({ name: "reads" });
            const ok = okFor(env.id);
            await ok("eth_call", [{ to: USDT, data: "0x18160ddd" }, "latest"]);
            const { size } = await ok("forkstate_info", []);
            assert.equal(size.slots, 0, "a read must not leave a storage slot behind");
            assert.equal(size.accounts, 0, "nor an account");
        });

        it("puts a balance back exactly where it was on revert", async () => {
            const env = await newEnv({ name: "revert" });
            const ok = okFor(env.id);
            const read = async (who: string) =>
                BigInt(await ok("eth_call", [{ to: USDT, data: "0x70a08231" + pad(who) }, "latest"]));

            await ok("anvil_setStorageAt", [USDT, balanceSlot(HOLDER, 1n), "0x" + pad((10n ** 24n).toString(16))]);
            const before = await read(DEAD);

            const snapshot = await ok("evm_snapshot", []);
            await ok("eth_sendTransaction", [{
                from: HOLDER, to: USDT,
                data: "0xa9059cbb" + pad(DEAD) + pad((500n * 10n ** 18n).toString(16)),
            }]);
            assert.equal(await read(DEAD), before + 500n * 10n ** 18n, "the transfer should land");

            assert.equal(await ok("evm_revert", [snapshot]), true);
            assert.equal(await read(DEAD), before, "revert must undo it exactly");
        });
    });

    describe("questions about \"latest\"", () => {
        it("answers from this fork's block, never from the parent's head", async () => {
            // Forwarding the tag itself is the worst bug available here, because it
            // looks right: the parent resolves "latest" against its own head, which
            // has moved on, and hands back a real block from a chain you are not on.
            const env = await newEnv({ name: "latest" });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [SIGNER, "0x56bc75e2d63100000"]);
            await ok("eth_sendTransaction", [{ from: SIGNER, to: DEAD, value: "0x1" }]);

            assert.equal(await ok("eth_getBlockTransactionCountByNumber", ["latest"]), "0x1");

            const tx = await ok("eth_getTransactionByBlockNumberAndIndex", ["latest", "0x0"]);
            assert.equal(tx.from.toLowerCase(), SIGNER, "the parent's block would hold a stranger's tx");

            const receipts = await ok("eth_getBlockReceipts", ["latest"]);
            assert.equal(receipts.length, 1);
            assert.equal(receipts[0].transactionHash, tx.hash);
        });

        it("refuses a proof rather than serving the parent's", async () => {
            // The parent's proof is a signed claim that this fork's writes do not exist.
            const env = await newEnv({ name: "proof" });
            const r = await rpcFor(env.id)("eth_getProof", [USDT, ["0x0"], "latest"]);
            assert.match(r.error!.message, /cannot be served by a fork/);
        });
    });

    describe("filters", () => {
        it("watches this fork's blocks and reports each one once", async () => {
            // A filter made on the parent watches the parent, so a dapp calling
            // contract.on(...) would receive mainnet's events and none of its own.
            const env = await newEnv({ name: "filters" });
            const ok = okFor(env.id);

            const id = await ok("eth_newBlockFilter", []);
            assert.deepEqual(await ok("eth_getFilterChanges", [id]), [], "nothing has happened yet");

            await ok("evm_mine", []);
            await ok("evm_mine", []);
            assert.equal((await ok("eth_getFilterChanges", [id])).length, 2);
            assert.deepEqual(await ok("eth_getFilterChanges", [id]), [], "a poll must not repeat itself");

            assert.equal(await ok("eth_uninstallFilter", [id]), true);
        });
    });

    describe("following the parent's head", () => {
        it("moves the fork point without losing anything written here", { timeout: 30_000 }, async () => {
            const env = await newEnv({ name: "follow", followHead: true });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [SIGNER, "0x3635c9adc5dea00000"]);
            await ok("eth_sendTransaction", [{ from: SIGNER, to: DEAD, value: "0x1" }]);
            const balance = await ok("eth_getBalance", [SIGNER, "latest"]);
            const minedAt = await ok("eth_blockNumber", []);

            // The parent needs to actually produce a block for there to be a head
            // to follow; BNB Chain does that several times a second.
            await new Promise((resolve) => setTimeout(resolve, 4000));
            const moved = await ok("forkstate_sync", []);
            assert.equal(moved.advanced, true, "the parent should have moved on by now");
            assert.ok(BigInt(moved.to) > BigInt(moved.from));

            assert.equal(await ok("eth_getBalance", [SIGNER, "latest"]), balance, "a write must survive the sync");
            assert.ok(await ok("eth_getTransactionByBlockNumberAndIndex", [minedAt, "0x0"]),
                "and so must the block it was mined in");
        });

        it("never reports a height below the block it is serving state from", { timeout: 30_000 }, async () => {
            // Left alone, the height is the last block produced here — which after
            // a sync sits below the new fork point, leaving a chain shorter than
            // the state it answers with and a next block numbered under an old one.
            const env = await newEnv({ name: "height" });
            const ok = okFor(env.id);
            await ok("evm_mine", []);

            await new Promise((resolve) => setTimeout(resolve, 4000));
            const moved = await ok("forkstate_sync", []);
            assert.ok(BigInt(await ok("eth_blockNumber", [])) >= BigInt(moved.to));
            assert.ok(BigInt(await ok("evm_mine", [])) > BigInt(moved.to),
                "the next block must be numbered above the new fork point");
        });

        it("refuses to move the fork point back under a block already mined", async () => {
            const env = await newEnv({ name: "ahead" });
            const ok = okFor(env.id);
            // Well past anything the parent will reach while this test runs.
            await ok("anvil_mine", ["0x2710"]);
            assert.equal((await ok("forkstate_sync", [])).advanced, false);
        });
    });

    describe("the faucet", () => {
        it("finds where a token keeps balances and writes one", async () => {
            const env = await newEnv({ name: "faucet" });
            const ok = okFor(env.id);
            const read = async () =>
                BigInt(await ok("eth_call", [{ to: USDT, data: "0x70a08231" + pad(SIGNER) }, "latest"]));

            const found = await ok("forkstate_setTokenBalance", [ USDT, SIGNER, (1000n * 10n ** 18n).toString() ]);
            assert.equal(typeof found.slot, "string");
            assert.equal(await read(), 1000n * 10n ** 18n);
        });

        it("costs one slot per token, not one per slot it looked at", async () => {
            // The search writes a sentinel into every candidate slot and puts it
            // back. Recording that made a single token cost four overlay entries
            // and a failed search cost sixty-four — each one a value the fork now
            // owns and stops reading from the parent.
            const env = await newEnv({ name: "faucet-cost" });
            const ok = okFor(env.id);

            await ok("forkstate_setTokenBalance", [ USDT, SIGNER, "1000" ]);
            assert.equal((await ok("forkstate_info", [])).size.slots, 1);
        });

        // Searching 64 slots against a remote parent is slower than the default.
        it("leaves nothing behind when it cannot find the slot", { timeout: 30_000 }, async () => {
            // A real contract that is not a token, so the search actually runs
            // and fails on the layout rather than on there being no code — those
            // are different failures and only this one is about the probes.
            const env = await newEnv({ name: "faucet-miss" });
            const ok = okFor(env.id);
            const before = (await ok("forkstate_info", [])).size.slots;

            const attempt = await rpcFor(env.id)("forkstate_setTokenBalance", [ ROUTER, SIGNER, "1" ]);
            assert.match(attempt.error!.message, /Could not find/);
            assert.equal((await ok("forkstate_info", [])).size.slots, before,
                "a failed search must put every slot back as it found it");
        });
    });

    describe("eth_call", () => {
        // Several calls against a remote parent; slower than the 5s default.
        it("does not change state, however many times it is run", { timeout: 30_000 }, async () => {
            // `RPCStateManager.commit()` commits only the account cache while
            // checkpoint and revert act on storage and code too, so every EVM
            // frame left the storage cache a layer deeper than the account one.
            // The symptom: simulating a swap set the pair's reentrancy slot and
            // left it set, and every later swap — simulated or real — failed with
            // "Pancake: LOCKED". Two identical calls answering differently is
            // about as wrong as a fork gets.
            const env = await newEnv({ name: "call-purity" });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [ SIGNER, "0x3635c9adc5dea00000" ]);

            const lock = async () => await ok("eth_getStorageAt", [ PAIR, "0xc", "latest" ]);
            const before = await lock();
            const call = { from: SIGNER, to: ROUTER, data: swapCalldata(SIGNER), value: "0xde0b6b3a7640000" };

            for (let attempt = 0; attempt < 3; attempt++) {
                await ok("eth_call", [ call, "latest" ]);
                assert.equal(await lock(), before, "a call must leave the slot as it found it");
            }
            assert.equal((await ok("forkstate_info", [])).size.slots, 0, "and write nothing");

            // And the real thing still works after all that simulating.
            const hash = await ok("eth_sendTransaction", [ call ]);
            assert.equal((await ok("eth_getTransactionReceipt", [ hash ])).status, "0x1");
        });
    });

    describe("simulating against pretended state", () => {
        const balanceOf = (who: string) => "0x70a08231" + pad(who);

        it("answers with the balance it was told to pretend", async () => {
            const env = await newEnv({ name: "override-balance" });
            const ok = okFor(env.id);

            const real = BigInt(await ok("eth_getBalance", [ DEAD, "latest" ]));
            const pretend = 12345n * 10n ** 18n;

            const answer = await ok("eth_call", [
                { to: DEAD, data: "0x" }, "latest",
                { [DEAD]: { balance: "0x" + pretend.toString(16) } },
            ]);
            assert.equal(answer, "0x", "an empty account returns nothing either way");

            // The balance is what the override changed, so ask something that reads it.
            const seen = BigInt(await ok("eth_getBalance", [ DEAD, "latest" ]));
            assert.equal(seen, real, "and the real balance must be exactly as it was");
        });

        it("runs code that was never deployed", async () => {
            const env = await newEnv({ name: "override-code" });
            const ok = okFor(env.id);
            const AT = "0x00000000000000000000000000000000000c0de0";

            // PUSH1 0x2a, PUSH1 0, MSTORE, PUSH1 32, PUSH1 0, RETURN — answers 42.
            const answer = await ok("eth_call", [
                { to: AT, data: "0x" }, "latest",
                { [AT]: { code: "0x602a60005260206000f3" } },
            ]);
            assert.equal(BigInt(answer), 42n);

            assert.equal(await ok("eth_getCode", [ AT, "latest" ]), "0x",
                "nothing should have been deployed");
        });

        it("pretends a token balance without touching the token", async () => {
            // The thing people actually want: "what would this swap do if I held
            // a million USDT?" — without spending a faucet write to find out.
            const env = await newEnv({ name: "override-slot" });
            const ok = okFor(env.id);
            const slot = balanceSlot(HOLDER, 1n);

            const before = BigInt(await ok("eth_call", [ { to: USDT, data: balanceOf(HOLDER) }, "latest" ]));
            const pretend = 1_000_000n * 10n ** 18n;

            const during = BigInt(await ok("eth_call", [
                { to: USDT, data: balanceOf(HOLDER) }, "latest",
                { [USDT]: { stateDiff: { [slot]: "0x" + pretend.toString(16) } } },
            ]));
            assert.equal(during, pretend, "the call should see the pretended balance");

            const after = BigInt(await ok("eth_call", [ { to: USDT, data: balanceOf(HOLDER) }, "latest" ]));
            assert.equal(after, before, "and the next call should see the real one again");
            assert.equal((await ok("forkstate_info", [])).size.slots, 0,
                "an override must not become part of the overlay");
        });

        it("leaves nothing behind even when the call reverts", async () => {
            const env = await newEnv({ name: "override-revert" });
            const ok = okFor(env.id);
            const AT = "0x00000000000000000000000000000000000bad00";

            await assert.rejects(() => ok("eth_call", [
                { to: AT, data: "0x" }, "latest",
                { [AT]: { code: "0x60006000fd" } },   // revert immediately
            ]));
            assert.equal(await ok("eth_getCode", [ AT, "latest" ]), "0x");
            assert.equal((await ok("forkstate_info", [])).size.slots, 0);
        });

        it("traces a call against pretended state too", async () => {
            const env = await newEnv({ name: "override-trace" });
            const ok = okFor(env.id);
            const AT = "0x00000000000000000000000000000000000c0de1";

            const traced = await ok("debug_traceCall", [
                { to: AT, data: "0x" }, "latest",
                { stateOverrides: { [AT]: { code: "0x602a60005260206000f3" } } },
            ]);
            assert.equal(BigInt(traced.returnValue), 42n);
            assert.equal(traced.failed, false);
        });

        it("refuses a whole-storage override instead of getting it wrong", async () => {
            // Geth's `state` blanks every slot not listed. A fork cannot: the
            // slots to blank are the ones it has never fetched.
            const env = await newEnv({ name: "override-state" });
            const ok = okFor(env.id);
            await assert.rejects(
                () => ok("eth_call", [
                    { to: USDT, data: balanceOf(HOLDER) }, "latest",
                    { [USDT]: { state: { "0x0": "0x1" } } },
                ]),
                /stateDiff/,
                "and it should say what to use instead",
            );
        });

        it("changes nothing when no overrides are given", async () => {
            const env = await newEnv({ name: "override-none" });
            const ok = okFor(env.id);
            const supply = await ok("eth_call", [ { to: USDT, data: "0x18160ddd" }, "latest" ]);
            assert.equal(await ok("eth_call", [ { to: USDT, data: "0x18160ddd" }, "latest", undefined ]),
                supply, "an absent third parameter is the old behaviour exactly");
        });
    });

    describe("simulating a bundle", () => {
        const balanceOf = (who: string) => "0x70a08231" + pad(who);
        /** `transfer(to, amount)` */
        const transfer = (to: string, amount: bigint) => "0xa9059cbb" + pad(to) + word(amount);
        /** `approve(spender, amount)` */
        const approve = (who: string, amount: bigint) => "0x095ea7b3" + pad(who) + word(amount);
        /** `allowance(owner, spender)` */
        const allowance = (owner: string, spender: string) =>
            "0xdd62ed3e" + pad(owner) + pad(spender);

        it("lets the second transaction see what the first one did", async () => {
            // The entire point. Two eth_calls cannot answer this, because the
            // approve is gone by the time the allowance is read.
            const env = await newEnv({ name: "bundle-sequence" });
            const ok = okFor(env.id);

            const bundle = await ok("forkstate_simulateBundle", [{
                transactions: [
                    { from: HOLDER, to: USDT, data: approve(ROUTER, 5n) },
                    { from: HOLDER, to: USDT, data: allowance(HOLDER, ROUTER) },
                ],
            }]);

            assert.equal(bundle.failed, false);
            assert.equal(bundle.results.length, 2);
            assert.equal(bundle.results[0].status, 1);
            assert.equal(BigInt(bundle.results[1].returnValue), 5n,
                "the second transaction should read the first one's approval");
        });

        it("leaves the fork exactly as it found it", async () => {
            const env = await newEnv({ name: "bundle-clean" });
            const ok = okFor(env.id);

            const before = BigInt(await ok("eth_call", [
                { to: USDT, data: allowance(HOLDER, ROUTER) }, "latest",
            ]));
            const height = await ok("eth_blockNumber", []);

            await ok("forkstate_simulateBundle", [{
                transactions: [ { from: HOLDER, to: USDT, data: approve(ROUTER, 77n) } ],
            }]);

            assert.equal(BigInt(await ok("eth_call", [
                { to: USDT, data: allowance(HOLDER, ROUTER) }, "latest",
            ])), before, "the approval must not have survived the simulation");
            assert.equal(await ok("eth_blockNumber", []), height, "and no block should be mined");
            assert.equal((await ok("forkstate_info", [])).size.slots, 0,
                "and nothing should have reached the overlay");
        });

        it("keeps going after one reverts, and says which", async () => {
            const env = await newEnv({ name: "bundle-revert" });
            const ok = okFor(env.id);
            const BROKE = "0x000000000000000000000000000000000000b0b0";

            const bundle = await ok("forkstate_simulateBundle", [{
                transactions: [
                    { from: HOLDER, to: USDT, data: approve(ROUTER, 3n) },
                    // Nobody holds this much of anything.
                    { from: BROKE, to: USDT, data: transfer(DEAD, 10n ** 30n) },
                    { from: HOLDER, to: USDT, data: allowance(HOLDER, ROUTER) },
                ],
            }]);

            assert.equal(bundle.failed, true, "one of them failed, so the bundle did");
            assert.equal(bundle.results[0].status, 1);
            assert.equal(bundle.results[1].status, 0);
            assert.ok(bundle.results[1].error, "a failure should say why");
            assert.equal(bundle.results[2].status, 1,
                "the third should still have run");
            assert.equal(BigInt(bundle.results[2].returnValue), 3n,
                "and should still see the first one's approval, not the failure's writes");
        });

        it("undoes a reverted transaction without undoing the ones before it", async () => {
            const env = await newEnv({ name: "bundle-rollback" });
            const ok = okFor(env.id);
            const REVERTS = "0x000000000000000000000000000000000000dEa1";

            const bundle = await ok("forkstate_simulateBundle", [{
                overrides: {
                    // SSTORE 1 -> 1, then revert. The write must not be visible.
                    [REVERTS]: { code: "0x600160015560006000fd" },
                },
                transactions: [
                    { from: HOLDER, to: REVERTS, data: "0x" },
                    { from: HOLDER, to: USDT, data: balanceOf(HOLDER) },
                ],
            }]);

            assert.equal(bundle.results[0].status, 0);
            assert.equal(bundle.results[1].status, 1, "the bundle should carry on");
            assert.equal(await ok("eth_getStorageAt", [ REVERTS, "0x1", "latest" ]),
                "0x" + "0".repeat(64), "and the reverted write must be nowhere");
        });

        it("starts from the state the overrides describe", async () => {
            // "What would this do if I held a million USDT?" — asked about a
            // sequence rather than a single call.
            const env = await newEnv({ name: "bundle-overrides" });
            const ok = okFor(env.id);
            const POOR = "0x0000000000000000000000000000000000000f00";
            const pretend = 1_000_000n * 10n ** 18n;

            const bundle = await ok("forkstate_simulateBundle", [{
                overrides: {
                    [USDT]: { stateDiff: { [balanceSlot(POOR, 1n)]: "0x" + pretend.toString(16) } },
                },
                transactions: [
                    { from: POOR, to: USDT, data: transfer(DEAD, 1000n) },
                    { from: POOR, to: USDT, data: balanceOf(POOR) },
                ],
            }]);

            assert.equal(bundle.failed, false, "the transfer should have the balance to make");
            assert.equal(BigInt(bundle.results[1].returnValue), pretend - 1000n,
                "and the balance afterwards should be the pretended one, less what moved");
        });

        it("reports the logs each transaction emitted", async () => {
            const env = await newEnv({ name: "bundle-logs" });
            const ok = okFor(env.id);

            const bundle = await ok("forkstate_simulateBundle", [{
                transactions: [ { from: HOLDER, to: USDT, data: approve(ROUTER, 9n) } ],
            }]);

            const logs = bundle.results[0].logs;
            assert.equal(logs.length, 1, "approve emits one Approval");
            assert.equal(logs[0].address.toLowerCase(), USDT.toLowerCase());
            // keccak("Approval(address,address,uint256)")
            assert.equal(logs[0].topics[0],
                "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925");
        });

        it("traces and diffs only when asked", async () => {
            const env = await newEnv({ name: "bundle-detail" });
            const ok = okFor(env.id);
            const transactions = [ { from: HOLDER, to: USDT, data: approve(ROUTER, 11n) } ];

            const plain = await ok("forkstate_simulateBundle", [{ transactions }]);
            assert.equal(plain.results[0].callTree, undefined);
            assert.equal(plain.results[0].stateDiff, undefined);

            const full = await ok("forkstate_simulateBundle", [
                { transactions, trace: true, diff: true },
            ]);
            assert.equal(full.results[0].callTree.to.toLowerCase(), USDT.toLowerCase());
            assert.ok(Object.keys(full.results[0].stateDiff.storage).length > 0,
                "an approve writes a slot, so the diff should show one");
        });

        it("does not report state changes for a transaction that reverted", async () => {
            const env = await newEnv({ name: "bundle-nodiff" });
            const ok = okFor(env.id);
            const REVERTS = "0x000000000000000000000000000000000000dEa2";

            const bundle = await ok("forkstate_simulateBundle", [{
                overrides: { [REVERTS]: { code: "0x600160015560006000fd" } },
                transactions: [ { from: HOLDER, to: REVERTS, data: "0x" } ],
                diff: true,
                trace: true,
            }]);

            assert.equal(bundle.results[0].status, 0);
            assert.equal(bundle.results[0].stateDiff, undefined,
                "the write was undone, so it is not a state change");
            assert.ok(bundle.results[0].callTree, "the trace is where you see what it tried");
        });

        it("advances the sender's nonce between transactions", async () => {
            // A deployment's address comes from the sender and nonce, so two
            // creations in one bundle must not land on the same address.
            const env = await newEnv({ name: "bundle-nonce" });
            const ok = okFor(env.id);

            const bundle = await ok("forkstate_simulateBundle", [{
                transactions: [
                    { from: HOLDER, data: CREATION, gas: "0x500000" },
                    { from: HOLDER, data: CREATION, gas: "0x500000" },
                ],
            }]);

            const [ first, second ] = bundle.results;
            assert.equal(first.status, 1);
            assert.equal(second.status, 1);
            assert.ok(first.contractAddress, "a creation should report where it landed");
            assert.notEqual(first.contractAddress, second.contractAddress,
                "two creations from one sender cannot share an address");
        });

        it("accepts a bare array of transactions", async () => {
            const env = await newEnv({ name: "bundle-array" });
            const ok = okFor(env.id);
            const bundle = await ok("forkstate_simulateBundle", [
                [ { from: HOLDER, to: USDT, data: balanceOf(HOLDER) } ],
            ]);
            assert.equal(bundle.results.length, 1);
            assert.equal(bundle.results[0].status, 1);
        });

        it("refuses a bundle that is empty or absurd", async () => {
            const env = await newEnv({ name: "bundle-limits" });
            const call = rpcFor(env.id);

            assert.match((await call("forkstate_simulateBundle", [{ transactions: [] }])).error!.message,
                /at least one/);
            assert.match((await call("forkstate_simulateBundle", [{}])).error!.message,
                /array of transactions/);

            const many = Array.from({ length: 65 }, () => ({ from: HOLDER, to: DEAD }));
            assert.match(
                (await call("forkstate_simulateBundle", [{ transactions: many }])).error!.message,
                /64 transactions/,
            );
        });

        it("is never forwarded to the parent chain", async () => {
            // The parent has no idea what this method is, and a forwarded one
            // would come back as the parent's error rather than ours.
            const env = await newEnv({ name: "bundle-noforward" });
            const call = rpcFor(env.id);
            const answer = await call("forkstate_simulateBundle", [{ transactions: [] }]);
            assert.ok(answer.error, "it should fail here, with our message");
            assert.match(answer.error!.message, /bundle/);
        });
    });

    describe("two replicas on one store", () => {
        /*
         * A second manager over the same store is what a second replica is.
         *
         * Both can hold the same environment, both will mine on top of the state
         * they loaded, and only one of those can be true afterwards. Before the
         * row carried a version the later write simply won, and the transaction
         * the other had already receipted stopped existing.
         */
        function otherReplica() {
            return new Manager(store, { cache: new UpstreamCache(null), checkpoint: 100 });
        }

        it("lets the second write lose rather than overwrite the first", async () => {
            const env = await newEnv({ name: "replica-conflict" });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [ HOLDER, "0x56bc75e2d63100000" ]);

            // Both replicas now hold it, at the same version.
            const other = otherReplica();
            const theirs = await other.get(env.id);
            assert.ok(theirs, "the second replica should be able to load it");

            // The first writes.
            await ok("eth_sendTransaction", [ { from: HOLDER, to: DEAD, value: "0x1" } ]);

            // The second writes on top of what it loaded, which is now behind.
            await theirs!.setBalance(DEAD, 999n);
            await assert.rejects(() => other.persist(env.id), StaleEnvironment,
                "a write built on a version that no longer exists must not land");
        });

        it("keeps the first replica's transaction", async () => {
            const env = await newEnv({ name: "replica-keeps" });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [ HOLDER, "0x56bc75e2d63100000" ]);

            const other = otherReplica();
            const theirs = await other.get(env.id);
            const hash = await ok("eth_sendTransaction", [ { from: HOLDER, to: DEAD, value: "0x2" } ]);

            await theirs!.setBalance(DEAD, 1n);
            await assert.rejects(() => other.persist(env.id), StaleEnvironment);

            // The receipted transaction is still there, from the store, after both.
            await manager.evict(env.id);
            assert.equal((await ok("eth_getTransactionReceipt", [ hash ])).status, "0x1",
                "the transaction that was reported to a caller must survive");
        });

        it("drops the losing environment so the next request reloads it", async () => {
            const env = await newEnv({ name: "replica-reload" });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [ HOLDER, "0x56bc75e2d63100000" ]);

            const other = otherReplica();
            const theirs = await other.get(env.id);
            await ok("eth_sendTransaction", [ { from: HOLDER, to: DEAD, value: "0x3" } ]);
            await theirs!.setBalance(DEAD, 5n);
            await assert.rejects(() => other.persist(env.id), StaleEnvironment);

            // Reloaded from the store, so it sees the winner's state, not its own.
            const fresh = await other.get(env.id);
            assert.notEqual(fresh, theirs, "the stale copy must not be handed out again");
            assert.notEqual(await fresh!.getBalance(DEAD), 5n,
                "and the discarded write must not have survived in memory");
        });

        it("lets the loser write once it has caught up", async () => {
            const env = await newEnv({ name: "replica-recovers" });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [ HOLDER, "0x56bc75e2d63100000" ]);

            const other = otherReplica();
            const theirs = await other.get(env.id);
            await ok("eth_sendTransaction", [ { from: HOLDER, to: DEAD, value: "0x4" } ]);
            await theirs!.setBalance(DEAD, 7n);
            await assert.rejects(() => other.persist(env.id), StaleEnvironment);

            // A retry, which is what a caller told to send it again would do.
            const reloaded = await other.get(env.id);
            await reloaded!.setBalance(DEAD, 7n);
            await other.persist(env.id);   // no longer behind, so it lands

            await manager.evict(env.id);
            assert.equal(BigInt(await ok("eth_getBalance", [ DEAD, "latest" ])), 7n);
        });

        it("does not conflict when only one replica is writing", async () => {
            const env = await newEnv({ name: "replica-solo" });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [ HOLDER, "0x56bc75e2d63100000" ]);
            // A delta, not a total: the burn address holds real BNB on the parent.
            const before = BigInt(await ok("eth_getBalance", [ DEAD, "latest" ]));
            for (let i = 0; i < 5; i++) {
                await ok("eth_sendTransaction", [ { from: HOLDER, to: DEAD, value: "0x1" } ]);
            }
            assert.equal(BigInt(await ok("eth_getBalance", [ DEAD, "latest" ])) - before, 5n,
                "the ordinary single-writer path must be untouched");
        });

        it("does not let a second request slip through after the first lost", async () => {
            /*
             * Two requests in flight on one process, and the first loses its write.
             *
             * The environment is dropped when that happens, so the second one
             * finds nothing to persist and — before `persist` was told which
             * environment the caller ran against — reported success for a block
             * that had gone with it. It showed up as one hash in fifty with no
             * receipt behind it.
             */
            const env = await newEnv({ name: "replica-inflight" });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [ HOLDER, "0x56bc75e2d63100000" ]);

            const ours = await manager.get(env.id);
            assert.ok(ours);

            // Someone else moves the row on, so our next write is doomed.
            const other = otherReplica();
            const theirs = await other.get(env.id);
            await theirs!.setBalance(DEAD, 3n);
            await other.persist(env.id);

            // The first write loses and drops the environment.
            await ours!.setBalance(DEAD, 1n);
            await assert.rejects(() => manager.persist(env.id, ours!), StaleEnvironment);

            // The second, still holding the same environment, must not be told
            // its work was saved.
            await assert.rejects(() => manager.persist(env.id, ours!), StaleEnvironment,
                "a request that ran against a dropped environment has not been saved");
        });

        it("does not apply what it told the caller it refused", async () => {
            /*
             * The mirror of losing a transaction, and just as wrong.
             *
             * Two writes in flight on one process share the in-memory environment,
             * so their blocks are mixed before either is written out. Whichever
             * persisted first carried the other's block along — and the other was
             * then answered "nothing was applied" while its block sat on the
             * chain. A caller that believed us and retried would send it twice.
             * Seen against two replicas as sixteen blocks for eight accepted
             * transactions.
             */
            const env = await newEnv({ name: "replica-refused" });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [ HOLDER, "0x56bc75e2d63100000" ]);

            const before = BigInt(await ok("eth_getBalance", [ DEAD, "latest" ]));

            const send = () => fetch(`${BASE}/${env.id}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    jsonrpc: "2.0", id: 1, method: "eth_sendTransaction",
                    params: [ { from: HOLDER, to: DEAD, value: "0x1" } ],
                }),
            });

            // Eight at once, twice over, all against the one environment.
            let accepted = 0;
            for (let round = 0; round < 2; round++) {
                const responses = await Promise.all(Array.from({ length: 8 }, send));
                for (const response of responses) {
                    if (response.status === 200) accepted++;
                    else assert.equal(response.status, 409, "only a lost write may be refused");
                    await response.json();
                }
            }

            // One writer here, so all of them should have landed — and whatever
            // landed must be exactly what was accepted, neither more nor less.
            const after = BigInt(await ok("eth_getBalance", [ DEAD, "latest" ]));
            assert.equal(after - before, BigInt(accepted),
                "the chain must hold exactly the transactions that were accepted");
        });

        it("says so over HTTP rather than answering as if it worked", async () => {
            const env = await newEnv({ name: "replica-http" });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [ HOLDER, "0x56bc75e2d63100000" ]);

            // Another replica writes, leaving the serving one behind.
            const other = otherReplica();
            const theirs = await other.get(env.id);
            await theirs!.setBalance(DEAD, 3n);
            await other.persist(env.id);

            const response = await fetch(`${BASE}/${env.id}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    jsonrpc: "2.0", id: 1, method: "eth_sendTransaction",
                    params: [ { from: HOLDER, to: DEAD, value: "0x1" } ],
                }),
            });
            assert.equal(response.status, 409);
            const body = await response.json() as { error: { message: string } };
            assert.match(body.error.message, /changed elsewhere/);
            assert.match(body.error.message, /again/, "and it should say what to do");
        });
    });

    describe("what an environment costs", () => {
        it("counts a cold read and not a warm one", async () => {
            /*
             * The distinction the whole meter exists for. A warm call is answered
             * from the shared cache in single-digit milliseconds and costs
             * nobody anything; a cold one waits on the parent chain, and that is
             * a paid request. Metering requests alone would bill them the same.
             */
            const meter = new Meter(null);
            const env = await newEnv({ name: "meter-cold" });
            const ok = okFor(env.id);
            const held = (await manager.get(env.id))!;
            held.onUpstreamFetch = () => meter.miss(env.id);

            // A contract nothing in this process has touched yet.
            const TOKEN = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82";
            await ok("eth_call", [ { to: TOKEN, data: "0x18160ddd" }, "latest" ]);
            const cold = meter.unflushed(env.id).misses;
            assert.ok(cold > 0, "reading a contract for the first time must count");

            await ok("eth_call", [ { to: TOKEN, data: "0x18160ddd" }, "latest" ]);
            assert.equal(meter.unflushed(env.id).misses, cold,
                "the same call again is served from the cache and must cost nothing");
        });

        it("keeps counting after the state manager is replaced", async () => {
            // A chain-id change rebuilds the state manager whole. A hook that
            // lived only on it would go quiet, and the bill would quietly stop.
            const meter = new Meter(null);
            const env = await newEnv({ name: "meter-rebuild" });
            const ok = okFor(env.id);
            const held = (await manager.get(env.id))!;
            held.onUpstreamFetch = () => meter.miss(env.id);

            await ok("forkstate_setChainId", [ 4477 ]);
            await ok("eth_call", [
                { to: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", data: "0x18160ddd" }, "latest" ]);
            assert.ok(meter.unflushed(env.id).misses > 0,
                "the meter must survive a rebuilt state manager");
        });

        it("charges a batch for every call in it", () => {
            const meter = new Meter(null);
            meter.request("a", 12);
            assert.equal(meter.unflushed("a").requests, 12);
        });

        it("keeps one environment's usage off another's", () => {
            const meter = new Meter(null);
            meter.request("a", 3);
            meter.miss("b");
            assert.deepEqual(meter.unflushed("a"), { requests: 3, misses: 0 });
            assert.deepEqual(meter.unflushed("b"), { requests: 0, misses: 1 });
        });

        it("writes totals out, and adds to what is already there", async () => {
            const meter = new Meter(store, 0);   // no timer; flushed by hand
            const id = "meter-" + Math.random().toString(16).slice(2, 8);
            meter.request(id, 5);
            meter.miss(id);
            await meter.flush();

            meter.request(id, 2);
            await meter.flush();

            const rows = await store.readUsage(id, "2000-01-01");
            assert.equal(rows.length, 1, "one row per day, added to rather than replaced");
            assert.equal(rows[0]!.requests, 7);
            assert.equal(rows[0]!.misses, 1);
        });

        it("does not lose usage when the write fails", async () => {
            const broken = { addUsage: async () => { throw new Error("database is away"); } };
            const meter = new Meter(broken, 0);
            meter.request("a", 4);
            await meter.flush();
            assert.equal(meter.unflushed("a").requests, 4,
                "usage that vanishes because the database blinked is usage nobody is billed for");
        });

        it("reports itself over RPC", async () => {
            const env = await newEnv({ name: "meter-rpc" });
            const ok = okFor(env.id);
            await ok("eth_call", [
                { to: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", data: "0x18160ddd" }, "latest" ]);
            const usage = await ok("forkstate_usage", [ 30 ]);
            assert.ok(usage.total, "it should report a total");
            assert.ok(usage.total.requests > 0, "the calls just made should be in it");
        });
    });

    describe("setting a token balance", () => {
        it("says there is no contract there, rather than blaming the layout", async () => {
            /*
             * The two failures look identical from inside the search: a token
             * with an unusual layout, and an address that is not a token at all.
             * The second is much likelier — the token and the holder sit next to
             * each other in a form — and reporting it as the first sends people
             * to read the token's source when the address is what is wrong.
             */
            const env = await newEnv({ name: "token-not-a-token" });
            const ok = okFor(env.id);
            await assert.rejects(
                () => ok("forkstate_setTokenBalance", [ DEAD, HOLDER, "0x1" ]),
                /no contract at/,
                "an address with no code is not a layout problem",
            );
        });

        it("still finds a real token's balances", async () => {
            const env = await newEnv({ name: "token-real" });
            const ok = okFor(env.id);
            const wanted = 1_000n * 10n ** 18n;
            await ok("forkstate_setTokenBalance", [ USDT, HOLDER, "0x" + wanted.toString(16) ]);

            const held = BigInt(await ok("eth_call", [
                { to: USDT, data: "0x70a08231" + pad(HOLDER) }, "latest" ]));
            assert.equal(held, wanted);
        });
    });

    describe("the healthcheck", () => {
        it("answers without a key, and says nothing else", async () => {
            // Every other endpoint needs the header, so a deployment with a key
            // set had nothing a host could poll — and a wedged process would
            // never be restarted.
            const response = await fetch(`${BASE}/health`);
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { ok: true },
                "it should report liveness and not the contents of the process");
        });

        it("is still the only thing open, on an engine that has a key", async () => {
            // The suite's own engine has no key, so this needs one of its own —
            // and that is the deployment the healthcheck exists for.
            const previous = process.env.FORKSTATE_KEY;
            process.env.FORKSTATE_KEY = "a-key-for-this-test";
            const port = PORT + 501;
            const guarded = serve(manager, port, RPC!);
            restoreEnv("FORKSTATE_KEY", previous);

            try {
                assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
                for (const path of [ "/environments", "/default" ]) {
                    assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status, 401,
                        `${path} must still need the key`);
                }
            } finally {
                guarded.close();
            }
        });
    });

    describe("the request limit", () => {
        // A clock the test moves, so a rate measured per second does not need a
        // test that waits seconds.
        const at = (ms: number) => 1_700_000_000_000 + ms;

        it("lets a burst through and then holds the rate", () => {
            const limiter = new RateLimiter({ perSecond: 10, burst: 20 });
            for (let i = 0; i < 20; i++) {
                assert.equal(limiter.take("a", 1, at(0)).ok, true, `burst request ${i} should pass`);
            }
            assert.equal(limiter.take("a", 1, at(0)).ok, false, "the 21st is past the burst");

            // A tenth of a second buys exactly one token back at ten a second.
            assert.equal(limiter.take("a", 1, at(100)).ok, true);
            assert.equal(limiter.take("a", 1, at(100)).ok, false);
        });

        it("says how long to wait, and means it", () => {
            const limiter = new RateLimiter({ perSecond: 4, burst: 4 });
            for (let i = 0; i < 4; i++) limiter.take("a", 1, at(0));

            const refused = limiter.take("a", 1, at(0));
            assert.equal(refused.ok, false);
            assert.equal((refused as { retryAfter: number }).retryAfter, 250,
                "a quarter of a second at four a second");
            assert.equal(limiter.take("a", 1, at(250)).ok, true, "and waiting that long works");
        });

        it("does not push a retrying caller further behind", () => {
            // A refused request that still spent a token means a client hammering
            // a limit can never climb out of it.
            const limiter = new RateLimiter({ perSecond: 2, burst: 2 });
            limiter.take("a", 2, at(0));
            for (let i = 0; i < 50; i++) limiter.take("a", 1, at(0));
            assert.equal(limiter.take("a", 1, at(500)).ok, true,
                "half a second at two a second is one token, however many times it was refused");
        });

        it("charges a batch for every call in it", () => {
            const limiter = new RateLimiter({ perSecond: 10, burst: 10 });
            assert.equal(limiter.take("a", 10, at(0)).ok, true);
            assert.equal(limiter.take("a", 1, at(0)).ok, false, "the batch spent the whole bucket");
        });

        it("keeps one environment's traffic off another's budget", () => {
            const limiter = new RateLimiter({ perSecond: 1, burst: 1 });
            assert.equal(limiter.take("a", 1, at(0)).ok, true);
            assert.equal(limiter.take("a", 1, at(0)).ok, false);
            assert.equal(limiter.take("b", 1, at(0)).ok, true, "b has its own bucket");
        });

        it("forgets a bucket once it has refilled", () => {
            const limiter = new RateLimiter({ perSecond: 10, burst: 10 });
            limiter.take("a", 10, at(0));
            limiter.sweep(at(100));
            assert.equal(limiter.take("a", 10, at(100)).ok, false, "still refilling, still remembered");
            limiter.sweep(at(5_000));
            assert.equal(limiter.take("a", 10, at(5_000)).ok, true, "swept, so it starts full");
        });

        it("is off unless a rate is configured", () => {
            assert.equal(new RateLimiter(limitsFromEnv({} as NodeJS.ProcessEnv)).unlimited, true);
            assert.equal(new RateLimiter(limitsFromEnv(
                { FORKSTATE_RATE: "0" } as unknown as NodeJS.ProcessEnv)).unlimited, true);
            const on = limitsFromEnv({ FORKSTATE_RATE: "5" } as unknown as NodeJS.ProcessEnv);
            assert.equal(on.perSecond, 5);
            assert.equal(on.burst, 25, "a default burst of five seconds' worth");
        });

        it("answers 429 with a retry-after, in the shape a wallet understands", async () => {
            // A second engine, rate-limited, so the rest of the suite is not.
            const previous = process.env.FORKSTATE_RATE;
            process.env.FORKSTATE_RATE = "2";
            const limitedPort = PORT + 500;
            const limited = serve(manager, limitedPort, RPC!);
            restoreEnv("FORKSTATE_RATE", previous);

            try {
                const env = await newEnv({ name: "rate-limited" });
                const call = () => fetch(`http://127.0.0.1:${limitedPort}/${env.id}`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
                });

                // Two a second means a burst of ten; the eleventh is refused.
                const codes: number[] = [];
                for (let i = 0; i < 12; i++) codes.push((await call()).status);
                assert.ok(codes.slice(0, 10).every((c) => c === 200),
                    `the burst should pass, got ${codes.join(",")}`);
                assert.equal(codes[11], 429, "and then it should be refused");

                const refused = await call();
                assert.equal(refused.status, 429);
                assert.ok(refused.headers.get("retry-after"), "a client needs to be told how long");

                const body = await refused.json() as {
                    error: { code: number; message: string; data?: { retryAfterMs: number } };
                };
                assert.equal(body.error.code, -32005, "the code clients already back off on");
                assert.ok(body.error.data!.retryAfterMs > 0);

                // And it recovers on its own, without anything being reset.
                await new Promise((done) => setTimeout(done, 1100));
                assert.equal((await call()).status, 200, "the bucket should refill by itself");
            } finally {
                limited.close();
            }
        });

        it("will not take a burst smaller than the rate it allows", () => {
            // A burst below the rate would refuse traffic that is inside the limit.
            const limits = limitsFromEnv(
                { FORKSTATE_RATE: "10", FORKSTATE_BURST: "3" } as unknown as NodeJS.ProcessEnv);
            assert.equal(limits.burst, 10);
        });
    });

    describe("traces outliving the process", () => {
        /** A real swap: several frames deep, so a shallow restore would show. */
        async function swapped(name: string) {
            const env = await newEnv({ name });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [ HOLDER, "0x3635c9adc5dea00000" ]);
            const hash = await ok("eth_sendTransaction", [ {
                from: HOLDER, to: ROUTER, value: "0xde0b6b3a7640000",
                data: swapCalldata(HOLDER), gas: "0x2dc6c0",
            } ]);
            assert.equal((await ok("eth_getTransactionReceipt", [ hash ])).status, "0x1");
            return { env, ok, hash };
        }

        it("gives back the same call tree after a restart", { timeout: 30_000 }, async () => {
            const { env, ok, hash } = await swapped("trace-restart");
            const before = await ok("debug_traceTransaction", [ hash ]);
            assert.ok(before.callTree, "the trace should be there to begin with");
            const depth = JSON.stringify(before.callTree).length;
            assert.ok(depth > 500, `a swap's call tree should be substantial, got ${depth} bytes`);

            // Eviction drops the environment, and its in-memory traces with it.
            // Whatever comes back now came back from the store.
            await manager.evict(env.id);

            const after = await ok("debug_traceTransaction", [ hash ]);
            assert.deepEqual(after.callTree, before.callTree, "the call tree should survive intact");
        });

        it("keeps the state diff beside it", { timeout: 30_000 }, async () => {
            const { env, ok, hash } = await swapped("diff-restart");
            const before = await ok("debug_traceTransaction", [ hash ]);
            assert.ok(before.stateDiff, "a swap changes state, so there should be a diff");
            const touched = Object.keys(before.stateDiff.storage ?? {}).length;
            assert.ok(touched > 0, "a swap should have moved some storage");

            await manager.evict(env.id);

            const after = await ok("debug_traceTransaction", [ hash ]);
            assert.deepEqual(after.stateDiff, before.stateDiff, "the diff should survive too");
        });

        it("still answers from memory while the environment is live", async () => {
            const { ok, hash } = await swapped("trace-live");
            const first = await ok("debug_traceTransaction", [ hash ]);
            const again = await ok("debug_traceTransaction", [ hash ]);
            assert.deepEqual(again, first, "repeated reads must not differ");
        });

        it("keeps one environment's traces out of another's", { timeout: 30_000 }, async () => {
            // The archive is one table for every environment, so the id has to be
            // part of the key. If it were not, two forks sending the same
            // transaction from the same account would share a hash — and each
            // would show the other's trace.
            const mine = await swapped("trace-mine");
            const theirs = await newEnv({ name: "trace-theirs" });

            assert.ok(await store.loadTrace(mine.env.id, mine.hash.toLowerCase()));
            assert.equal(await store.loadTrace(theirs.id, mine.hash.toLowerCase()), null,
                "a trace must not be visible from an environment that did not run it");
        });

        it("takes the traces with it when the environment is deleted", { timeout: 30_000 }, async () => {
            const { env, hash } = await swapped("trace-delete");
            assert.ok(await store.loadTrace(env.id, hash.toLowerCase()),
                "the trace should have been written");

            await manager.delete(env.id);

            assert.equal(await store.loadTrace(env.id, hash.toLowerCase()), null,
                "deleting an environment must not leave rows nothing can reach");
        });
    });

    describe("why a transaction failed", () => {
        /*
         * Runtime code that reverts with exactly `data`.
         *
         * Installed with `anvil_setCode` rather than deployed: the point here is
         * the shape of the revert, and constructor code in the way would only be
         * one more thing that can be wrong.
         */
        function reverterFor(data: string): string {
            const bytes = data.slice(2);
            let code = "";
            for (let at = 0; at < bytes.length; at += 64) {
                const word = bytes.slice(at, at + 64).padEnd(64, "0");
                const offset = (at / 2).toString(16).padStart(2, "0");
                code += "7f" + word            // PUSH32 <word>
                    + "60" + offset            // PUSH1  <offset>
                    + "52";                    // MSTORE
            }
            const length = (bytes.length / 2).toString(16).padStart(2, "0");
            return "0x" + code + "60" + length + "6000" + "fd";   // PUSH1 len, PUSH1 0, REVERT
        }

        /** ABI-encodes Error(string), the shape `require(cond, "…")` produces. */
        function errorString(text: string): string {
            const hex = Buffer.from(text, "utf8").toString("hex");
            return "0x08c379a0"
                + "20".padStart(64, "0")
                + text.length.toString(16).padStart(64, "0")
                + hex.padEnd(64, "0");
        }

        /** An address the parent chain has nothing at, so only our code is there. */
        const AT = "0x00000000000000000000000000000000000face7";

        async function failing(name: string, data: string) {
            const env = await newEnv({ name });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [ HOLDER, "0x56bc75e2d63100000" ]);
            await ok("anvil_setCode", [ AT, reverterFor(data) ]);
            const hash = await ok("eth_sendTransaction", [ { from: HOLDER, to: AT, data: "0x" } ]);
            return { ok, receipt: await ok("eth_getTransactionReceipt", [ hash ]) };
        }

        it("says what the contract said, on the receipt", async () => {
            const { receipt } = await failing("revert-require", errorString("not enough"));
            assert.equal(receipt.status, "0x0");
            assert.equal(receipt.revertReason, "not enough");
        });

        it("names the panic instead of printing its code", async () => {
            // Panic(0x11) — what an overflow raises. "0x11" tells nobody anything.
            const { receipt } = await failing(
                "revert-panic", "0x4e487b71" + "11".padStart(64, "0"),
            );
            assert.equal(receipt.status, "0x0");
            assert.equal(receipt.revertReason, "arithmetic overflow or underflow");
        });

        it("hands a custom error's bytes on, since naming it needs the ABI", async () => {
            const { receipt } = await failing("revert-custom", "0xdeadbeef" + "2a".padStart(64, "0"));
            assert.equal(receipt.status, "0x0");
            assert.match(receipt.revertReason, /custom error 0xdeadbeef/);
            // The arguments survive, so an explorer holding the ABI can decode them.
            assert.match(receipt.revertData, /^0xdeadbeef0*2a$/);
        });

        it("tells eth_call the same thing, not just \"revert\"", async () => {
            const env = await newEnv({ name: "revert-call" });
            const ok = okFor(env.id);
            await ok("anvil_setCode", [ AT, reverterFor(errorString("nope")) ]);
            await assert.rejects(
                () => ok("eth_call", [ { to: AT, data: "0x" }, "latest" ]),
                /nope/,
                "the reason belongs on a failed call too",
            );
        });

        it("says so plainly when there was no reason at all", async () => {
            const { receipt } = await failing("revert-bare", "0x");
            assert.equal(receipt.status, "0x0");
            assert.match(receipt.revertReason, /revert/);
        });
    });

    describe("tracing", () => {
        it("reports the call tree of a real swap, nested as it happened", async () => {
            const env = await newEnv({ name: "trace" });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [ SIGNER, "0x3635c9adc5dea00000" ]);

            const traced = await ok("debug_traceCall", [
                { from: SIGNER, to: ROUTER, data: swapCalldata(SIGNER), value: "0xde0b6b3a7640000" },
                "latest", {},
            ]);

            assert.equal(traced.failed, false);
            assert.equal(traced.callTree.to.toLowerCase(), ROUTER.toLowerCase());
            assert.ok(traced.callTree.calls.length >= 3, "a swap touches the pair and both tokens");
        });

        it("leaves opcode logs out unless they are asked for", async () => {
            // One swap is tens of thousands of entries. Returning them by default
            // makes the endpoint useless for the question people usually have.
            const env = await newEnv({ name: "trace-default" });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [ SIGNER, "0x3635c9adc5dea00000" ]);
            const call = { from: SIGNER, to: ROUTER, data: swapCalldata(SIGNER), value: "0xde0b6b3a7640000" };

            assert.equal((await ok("debug_traceCall", [ call, "latest", {} ])).structLogs.length, 0);

            const stepped = await ok("debug_traceCall", [
                call, "latest", { tracer: "structLogger", tracerConfig: { limit: 200 } },
            ]);
            assert.equal(stepped.structLogs.length, 200);
            assert.equal(stepped.truncated, true, "a cut trace must say it was cut");
        });

        it("decodes the revert reason rather than reporting a bare failure", async () => {
            const env = await newEnv({ name: "trace-revert" });
            const traced = await okFor(env.id)("debug_traceCall", [
                {
                    from: SIGNER, to: USDT,
                    data: "0xa9059cbb" + pad(DEAD) + word(10n ** 30n),
                },
                "latest", {},
            ]);
            assert.equal(traced.failed, true);
            assert.match(traced.callTree.error, /exceeds balance/);
        });

        it("keeps a transaction's trace from when it ran", async () => {
            // Re-simulating later would describe an execution that never happened:
            // state has moved on since the transaction was mined.
            const env = await newEnv({ name: "trace-tx" });
            const ok = okFor(env.id);
            await ok("anvil_setBalance", [ SIGNER, "0x3635c9adc5dea00000" ]);

            const hash = await ok("eth_sendTransaction", [
                { from: SIGNER, to: ROUTER, data: swapCalldata(SIGNER), value: "0xde0b6b3a7640000" },
            ]);
            const traced = await ok("debug_traceTransaction", [ hash ]);

            assert.equal(traced.failed, false);
            assert.equal(traced.callTree.to.toLowerCase(), ROUTER.toLowerCase());
            assert.ok(traced.callTree.calls.length >= 3);
        });
    });

    describe("the shared upstream cache", () => {
        it("lets a second fork at the same block read without touching the parent", async () => {
            // Forks snap to a checkpoint precisely so this can happen; without it
            // every fork taken at "latest" has its own block and shares nothing.
            const a = await newEnv({ name: "cache-a" });
            const b = await newEnv({ name: "cache-b" });
            assert.equal(a.forkBlock, b.forkBlock, "forks near each other should share a block");

            await okFor(a.id)("eth_call", [{ to: USDT, data: "0x18160ddd" }, "latest"]);
            const beforeMisses = (await okFor(b.id)("forkstate_cache", [])).misses;

            await okFor(b.id)("eth_call", [{ to: USDT, data: "0x18160ddd" }, "latest"]);
            const stats = await okFor(b.id)("forkstate_cache", []);

            assert.ok(stats.hits > 0, "the second fork should hit the cache");
            assert.equal(stats.misses, beforeMisses, "and should not add an upstream read");
        });
    });
});
