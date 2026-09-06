import { keccak_256 } from "@noble/hashes/sha3.js";
const R = "http://127.0.0.1:8546";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const A = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const pad = (h: string) => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const q = async (method: string, params: unknown[] = []) => {
    const r = await fetch(R, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
        .then((res) => res.json()) as { result?: any; error?: { message: string } };
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result;
};
const tok = (h: string) => h && h !== "0x" ? (BigInt(h) / 10n ** 18n).toString() : "0";
const slot = (w: string) => "0x" + Buffer.from(keccak_256(Buffer.from(pad(w) + pad("1"), "hex"))).toString("hex");

await q("anvil_setStorageAt", [ USDT, slot(A), "0x" + pad((10n ** 24n).toString(16)) ]);
console.log("  A ka USDT          ", tok(await q("eth_call", [ { to: USDT, data: "0x70a08231" + pad(A) }, "latest" ])));

const snap = await q("evm_snapshot");
console.log("  snapshot            ", snap);

const hash = await q("eth_sendTransaction", [ { from: A, to: USDT, data: "0xa9059cbb" + pad(B) + pad((500n * 10n ** 18n).toString(16)) } ]);
console.log("  tx bheji            ", String(hash).slice(0, 20) + "…");

const receipt = await q("eth_getTransactionReceipt", [ hash ]);
console.log("  receipt status      ", receipt.status, " gas", BigInt(receipt.gasUsed), " logs", receipt.logs.length);

const block = await q("eth_getBlockByNumber", [ receipt.blockNumber, false ]);
console.log("  block               ", BigInt(block.number), "  txs", block.transactions.length);

const logs = await q("eth_getLogs", [ { address: USDT } ]);
console.log("  eth_getLogs         ", logs.length, "log(s), topic0", String(logs[0]?.topics?.[0]).slice(0, 20) + "…");

console.log("  B ka USDT           ", tok(await q("eth_call", [ { to: USDT, data: "0x70a08231" + pad(B) }, "latest" ])));

await q("evm_revert", [ snap ]);
console.log("  revert ke baad B    ", tok(await q("eth_call", [ { to: USDT, data: "0x70a08231" + pad(B) }, "latest" ])));
console.log("  revert ke baad A    ", tok(await q("eth_call", [ { to: USDT, data: "0x70a08231" + pad(A) }, "latest" ])));

// passthrough: fork se neeche ka block parent chain se aana chahiye
const old = await q("eth_getBlockByNumber", [ "0x7000000", false ]);
console.log("  purana block (parent)", BigInt(old.number), " txs", old.transactions.length);

console.log("  info                ", JSON.stringify(await q("forkstate_info")));
