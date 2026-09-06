import { Environment } from "../../src/environment.ts";

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

const RPC = requireRpc();
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const pad = (h: string) => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");

const head = BigInt(await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) })
  .then(r => r.json()).then((j: any) => j.result));

for (const back of [ 0n, 1_000n, 100_000n, 1_000_000n, 10_000_000n ]) {
  const at = head - back;
  try {
    const env = await Environment.create({ rpcUrl: RPC, forkBlock: at });
    const supply = await env.call({ to: USDT, data: "0x18160ddd" });
    const code = await env.getCode(USDT);
    console.log(`  ${String(back).padStart(10)} peeche (block ${at})  code ${((code.length - 2) / 2).toString().padStart(4)}B  totalSupply ${(BigInt(supply.returnValue) / 10n ** 18n).toLocaleString("en-US")}`);
  } catch (e) {
    console.log(`  ${String(back).padStart(10)} peeche  FAIL: ${(e as Error).message.slice(0, 70)}`);
  }
}
