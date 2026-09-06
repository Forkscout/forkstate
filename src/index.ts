/**
 * forkstate — a fork that does not copy.
 *
 * Mainnet state is read through to the parent chain on demand; writes stay in a
 * local overlay. An environment costs what it has written and nothing else, so a
 * process holds hundreds of them and a restart loses none.
 */
import { Environment } from "./environment.ts";
import { Manager } from "./manager.ts";
import { Store } from "./store.ts";
import { openBackend } from "./backend.ts";
import { UpstreamCache } from "./upstream-cache.ts";
import { serve } from "./server.ts";

const RPC = process.env.FORKSTATE_RPC;
/*
 * `PORT` is what every hosting platform sets, and what its router expects the
 * process to be listening on. `FORKSTATE_PORT` stays first so a local run can
 * still pin it deliberately.
 */
const PORT = Number(process.env.FORKSTATE_PORT ?? process.env.PORT ?? 8546);
const DB = process.env.FORKSTATE_DB ?? "./data/forkstate.db";
/*
 * Postgres when it is set, a local file otherwise.
 *
 * A disk is faster — measured at a 185 ms cold start against 3.2 seconds with no
 * cache — but it has to exist. Pointing this at Postgres lets the engine run
 * anywhere that keeps a process alive, with no volume to arrange.
 */
const DATABASE_URL = process.env.DATABASE_URL;
// Shared by every environment: the parent chain's state at a block is the same for
// all of them, so one fork paying for a read pays for everyone's.
const CACHE_DB = process.env.FORKSTATE_CACHE === "0" ? null : (process.env.FORKSTATE_CACHE ?? "./data/upstream.db");
// Forks taken at "latest" snap to a multiple of this so they share a cache.
const CHECKPOINT = Number(process.env.FORKSTATE_CHECKPOINT ?? 100);
const CHAIN_ID = process.env.FORKSTATE_CHAIN_ID ? Number(process.env.FORKSTATE_CHAIN_ID) : undefined;
// Following the parent's head costs a re-read of whatever state is in use, so it
// is opt-in per environment; this only says how often the followers are pulled up.
const SYNC_INTERVAL = Number(process.env.FORKSTATE_SYNC_INTERVAL ?? 12);
const FOLLOW_HEAD = process.env.FORKSTATE_FOLLOW_HEAD === "1";

if (!RPC) {
    console.error("Set FORKSTATE_RPC to the chain this should fork.");
    process.exit(1);
}

const backend = await openBackend({ url: DATABASE_URL, path: DB });
const store = new Store(backend);
// The same place, because the cache is only useful when it outlives one process.
const cache = CACHE_DB === null ? new UpstreamCache(null) : new UpstreamCache(backend);
const manager = new Manager(store, {
    cache, checkpoint: CHECKPOINT, chainId: CHAIN_ID, syncInterval: SYNC_INTERVAL,
});

// A "default" environment so a bare URL works, the way a single-chain node does.
if (!(await manager.get("default"))) {
    const env = await Environment.create({ rpcUrl: RPC, chainId: CHAIN_ID, cache, checkpoint: CHECKPOINT });
    env.followsHead = FOLLOW_HEAD;
    // Awaited: the line below reads it back, and against Postgres an unawaited
    // write loses that race.
    await store.save({
        id: "default", name: "default", rpcUrl: RPC,
        chainId: env.chainId, forkBlock: "0x" + env.forkBlock.toString(16),
        createdAt: Date.now(), updatedAt: Date.now(),
        overlay: env.exportOverlay(), chain: env.exportChain(),
        followsHead: FOLLOW_HEAD,
        // A row nobody has written yet. If another replica got there first this
        // write loses, which is right: theirs is the default and ours was a guess.
        revision: 0,
    });
}

serve(manager, PORT, RPC);

const preset = await manager.get("default");
console.log(`forkstate on http://127.0.0.1:${PORT}`);
console.log(`  default   chain ${preset?.chainId} at block ${preset?.forkBlock}`);
if (!CHAIN_ID) {
    console.log(`  note      forks reuse the parent's chain id; set FORKSTATE_CHAIN_ID to give them their own`);
}
console.log(`  parent    ${RPC.replace(/\/[^/]{12,}$/, "/…")}`);
console.log(`  store     ${DATABASE_URL ? "postgres" : DB} — ${(await store.list()).length} environment(s)`);
console.log(`  cache     ${CACHE_DB === null ? "memory only" : (DATABASE_URL ? "postgres" : CACHE_DB)} — forks snap to every ${CHECKPOINT} blocks`);
console.log(`  head sync ${SYNC_INTERVAL > 0 ? `every ${SYNC_INTERVAL}s for forks that follow it` : "off"}`);
console.log(`  new fork  POST /environments`);
