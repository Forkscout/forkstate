import { Environment } from "../../src/environment.ts";
import { keccak_256 } from "@noble/hashes/sha3.js";

/**
 * The parent chain to read through to.
 *
 * No default on purpose. A URL baked in here is one more place a key gets
 * committed, and an exploratory script that quietly runs against somebody
 * else's endpoint is worse than one that refuses to start.
 */
function requireRpc(): string {
    const url = process.env.FORKSTATE_RPC;
    if (!url) throw new Error("Set FORKSTATE_RPC to an archive node for the chain you want to fork.");
    return url;
}


const RPC  = requireRpc();
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const A    = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const B    = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const pad = (h: string) => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const balanceOf = (who: string) => "0x70a08231" + pad(who);
const transfer = (to: string, amount: bigint) => "0xa9059cbb" + pad(to) + pad(amount.toString(16));
const tok = (hex: string) => hex && hex !== "0x" ? (BigInt(hex) / 10n ** 18n).toString() : "0";
const slotOf = (who: string) => "0x" + Buffer.from(keccak_256(Buffer.from(pad(who) + pad("1"), "hex"))).toString("hex");

const env = await Environment.create({ rpcUrl: RPC });
console.log(`  fork      chain ${env.chainId} @ ${env.forkBlock}`);

await env.setStorageAt(USDT, slotOf(A), "0x" + (10n ** 24n).toString(16));
await env.setBalance(A, 100n * 10n ** 18n);
console.log(`  A ke paas ${tok((await env.call({ to: USDT, data: balanceOf(A) })).returnValue)} USDT`);

console.log(`  block     ${env.blockNumber()}`);
const tx = await env.sendTransaction({ from: A, to: USDT, data: transfer(B, 500n * 10n ** 18n) });
console.log(`  tx        ${tx.hash.slice(0, 18)}…  status ${tx.status}  gas ${BigInt(tx.gasUsed)}  logs ${tx.logs.length}`);
console.log(`  block     ${env.blockNumber()}  (transaction pe bana)`);

console.log(`  A baad    ${tok((await env.call({ to: USDT, data: balanceOf(A) })).returnValue)} USDT`);
console.log(`  B baad    ${tok((await env.call({ to: USDT, data: balanceOf(B) })).returnValue)} USDT`);

if (tx.logs[0]) {
  console.log(`  log       ${tx.logs[0].topics[0]?.slice(0, 18)}…  (Transfer event)`);
}

const size = env.size();
console.log(`  overlay   ${size.accounts} accounts, ${size.slots} slots, ${size.bytes} bytes`);

// restore: kya transaction ka asar bhi bacha?
const restored = await Environment.restore(env.exportOverlay(), RPC);
console.log(`  restore   A ${tok((await restored.call({ to: USDT, data: balanceOf(A) })).returnValue)} · B ${tok((await restored.call({ to: USDT, data: balanceOf(B) })).returnValue)} USDT`);

// revert reason bhi aata he?
const bad = await env.sendTransaction({ from: B, to: USDT, data: transfer(A, 10n ** 30n) });
console.log(`  revert    status ${bad.status}  reason: ${bad.error}`);
