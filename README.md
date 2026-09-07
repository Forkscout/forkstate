# forkstate

[![CI](https://github.com/Forkscout/forkstate/actions/workflows/ci.yml/badge.svg)](https://github.com/Forkscout/forkstate/actions/workflows/ci.yml)

A fork that does not copy.

Mainnet state is read through to the parent chain the first time it is asked for;
writes stay in a local overlay. An environment is worth its writes and nothing
else — an untouched fork of BNB Chain is **73 bytes**, and one that has patched a
token balance and executed a transfer is **512**.

Twenty-six forks in one container come to **1,768 bytes of state and 68 MB of
RAM**. The same thing done with a node per fork is a process and a chain each.

For comparison, that node: one that ran for two days on a 15-second block time
reached a 1.8 GB state file, and dumping a file that size is work it does instead
of answering.

## Quick start

```bash
docker run -p 8546:8546 -e FORKSTATE_RPC=https://your-node/… forkstate
```

Or from source, on either runtime — Node 22.6 or newer, or Bun 1.2 or newer:

```bash
npm install  &&  FORKSTATE_RPC=https://your-node/… npm start
bun install  &&  FORKSTATE_RPC=https://your-node/… bun run start:bun
```

The image is built on Bun for one measured reason: its binary is 70 MB against
Node's 121 MB and it needs no package manager at runtime, which takes the image
from 208 MB to **141 MB** and idle memory from 56 MB to **34 MB**. The two
runtimes disagree about exactly one thing — Node ships `node:sqlite`, Bun ships
`bun:sqlite` — and `src/sqlite.ts` is the thirty lines that hide it. The suite
runs green on both.

Then open <http://127.0.0.1:8546> for the console, or point a wallet, `cast` or a
dapp at that URL and it sees a normal JSON-RPC node.

## Many forks, one process

Each environment gets its own URL. Nothing is shared between them except the
parent chain's state, which is the same for all of them anyway.

```bash
curl -X POST localhost:8546/environments -d '{"name":"alice"}'
#  { "id": "7105ce1d", "rpcUrl": "http://127.0.0.1:8546/7105ce1d", … }

curl -X DELETE localhost:8546/environments/7105ce1d
```

Anything an environment cannot answer is forwarded to the parent chain. A block
from last year, a receipt from before the fork, a method not implemented here —
the parent has them, and answering as if it did not would make a wallet's history
disappear.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `FORKSTATE_RPC` | — | The chain to fork. Required. |
| `FORKSTATE_PORT` | `8546` | HTTP port |
| `DATABASE_URL` | — | Postgres. When set, nothing is written to disk. |
| `FORKSTATE_DB` | `./data/forkstate.db` | Where environments are kept, without `DATABASE_URL` |
| `FORKSTATE_CACHE` | `./data/upstream.db` | Shared parent-state cache; `0` keeps it in memory only |
| `FORKSTATE_KEY` | — | Required in an `x-forkstate-key` header when set. See below. |
| `FORKSTATE_CHECKPOINT` | `100` | Round an unpinned fork down to a multiple of this |
| `FORKSTATE_SYNC_INTERVAL` | `12` | Seconds between head syncs for forks that follow it; `0` disables |
| `FORKSTATE_FOLLOW_HEAD` | `0` | Whether the preset `default` environment follows the head |
| `FORKSTATE_CHAIN_ID` | the parent's | A distinct id stops a wallet answering from its own services |
| `FORKSTATE_RATE` | — | Requests per second per environment; unset means no limit |
| `FORKSTATE_BURST` | `5 × rate` | How many may arrive at once before that rate applies |
| `FORKSTATE_SOLC_DIR` | `./data/solc` | Where downloaded compilers are kept for verification |

`GET /health` answers `{"ok":true}` without a key, so a host can tell whether the
process is alive. Everything else needs the header when one is set.

That last one is not cosmetic. A wallet that recognises chain 56 will answer some
questions from its own infrastructure rather than from the node it was given —
token balances come back right and the native balance comes back as whatever the
address holds on the real chain. Give a fork its own id.

## What works

**Answered here**, from the fork's own state and blocks: `eth_call`,
`eth_estimateGas`, `eth_sendTransaction`, `eth_sendRawTransaction` (legacy and
EIP-1559), `eth_getBalance`, `eth_getCode`, `eth_getTransactionCount`,
`eth_getStorageAt`, `eth_blockNumber`, `eth_getBlockBy{Number,Hash}`,
`eth_getBlockTransactionCountBy{Number,Hash}`,
`eth_getTransactionBy{Hash,BlockNumberAndIndex,BlockHashAndIndex}`,
`eth_getTransactionReceipt`, `eth_getBlockReceipts`, `eth_getLogs`, the filter
methods (`eth_newFilter`, `eth_newBlockFilter`, `eth_getFilterChanges`,
`eth_getFilterLogs`, `eth_uninstallFilter`), `eth_gasPrice`, `eth_feeHistory`,
`eth_maxPriorityFeePerGas`, `eth_chainId`, and the node facts a wallet probes on
connect (`eth_syncing`, `eth_mining`, `eth_coinbase`, `net_version`, …).

A failed receipt carries `revertReason` and `revertData` alongside `status: 0x0`.
The reason is decoded where it can be: `Error(string)` gives its own sentence and
`Panic(uint256)` is named rather than printed as `0x11`. A custom error cannot be
named without the ABI, so its four selector bytes are reported and the raw data
travels with it for whoever holds one. `eth_call` reports the same reason instead
of a bare "revert".

`eth_call` also takes Geth's third parameter — state to pretend is true for that
call. `balance`, `nonce`, `code` and `stateDiff` per address, applied inside the
checkpoint the call is already thrown away with, so nothing reaches the fork.
Geth's `state`, which blanks every slot not listed, is refused: the slots a fork
would have to blank are the ones it has never read.

**Tracing:** `debug_traceCall` returns the call tree of a call that is never
committed; `debug_traceTransaction` returns the tree kept from when a
transaction ran here. Opcode-level entries are opt-in — one swap is tens of
thousands of them. Traces and state diffs are written beside the environment, so
a restart does not empty them.

**Cheatcodes:** `anvil_setBalance`, `setNonce`, `setCode`, `setStorageAt`,
`impersonateAccount`, `autoImpersonateAccount`, `anvil_mine`, `evm_mine`,
`evm_increaseTime`, `evm_snapshot`, `evm_revert`, and
`forkstate_setTokenBalance`, which finds where a token keeps balances and
writes one.

**About this fork:** `forkstate_info`, `forkstate_overlay`, `forkstate_size`,
`forkstate_cache`, `forkstate_sync`, `forkstate_followHead`,
`forkstate_setChainId`, `forkstate_contracts`.

**Verification:** `forkstate_verify` and `forkstate_verifyStatus` compile
submitted source and compare it to the deployed code. The compiler is downloaded
once and run in a process of its own, so a slow or failing compile cannot stall
the RPC every other environment is being served from.

**Refused, with a reason:** `eth_getProof` (the parent's proof is a signed claim
that this fork's writes do not exist), `eth_sign` and `eth_signTransaction` (no
key is ever held here — sign in your wallet and send the raw transaction), and
`eth_subscribe` (needs a socket; poll a filter instead).

**Forwarded to the parent:** everything else — history from before the fork,
which the parent has and this process never will.

```bash
npm test       # needs FORKSTATE_RPC — it forks a real chain
bun test ./test/suite.ts
```

## Pinned, or following the head

A fork is pinned by default: it takes the parent's state at one block and stays
there, which is what you want for a test that has to mean the same thing next
week. Pass `forkBlock` to choose the block, or let it snap to a checkpoint.

A fork can also follow the parent's head, so new mainnet blocks keep arriving
underneath your own changes:

```bash
curl -X POST localhost:8546/environments -d '{"name":"live","followHead":true}'
```

Followers are pulled up every `FORKSTATE_SYNC_INTERVAL` seconds, and
`forkstate_sync` moves one immediately. This is cheap for the same reason the
fork itself is: nothing was copied, so following the head means reading at a
newer block tag and replaying the same overlay onto it.

Two things to be clear about, because both are inherent rather than temporary:

- **The overlay holds values, not operations.** A balance you set still reads
  back as you set it. A balance some transaction *computed* from parent state was
  computed against the older block, and syncing does not recalculate it.
- **Blocks mined before a sync keep their numbers**, which afterwards sit inside
  the range the parent also covers. This fork's own history wins for those, the
  same way the overlay wins over parent state.

What syncing will not do is move the fork point back under a block already mined
here. A chain whose height goes backwards serves two different blocks under one
number, and every receipt it has already handed out starts lying.

## Where it runs

It needs a process that stays alive: environments live in memory, and the
head-sync runs on a timer. That rules out Vercel and anything else that ends the
process with the request. Any container host does — Railway, Fly, Render — and
the image is 141 MB idling at 34 MB.

A disk is optional. Set `DATABASE_URL` and both the environments and the shared
cache go to Postgres instead, so no volume has to be arranged. It costs a slower
cold start, measured on the same swap:

| | first call | cold start | warm |
| --- | --- | --- | --- |
| SQLite on a disk | 3.2 s | **185 ms** | 7 ms |
| Postgres, no disk | 3.6 s | **1.08 s** | 12 ms |
| no cache at all | 3.6 s | 3.6 s | 3.6 s |

The cold start is what a restart costs; the warm number is every call after it.
Either beats paying the parent chain again — that column on the right is the
whole point of the cache.

### The engine has no idea who owns what

That is deliberate: it stays a node, and a console in front of it decides who may
touch which environment. The consequence is that a publicly reachable engine
serves every environment in the process to anyone who guesses an eight-character
id.

So when it is reachable from outside, set `FORKSTATE_KEY` and every request must
carry it in an `x-forkstate-key` header. The built-in UI is not served then — a
browser cannot send a header, and the console is the interface in that
deployment. Leave it unset for a process on localhost or a private network.

## Limits

Unset, there are none. Set `FORKSTATE_RATE` and each environment gets a token
bucket: a burst arrives at once, then the rate applies. A batch is charged for
every call in it, so batching stays a way to be efficient rather than a way
around the limit.

Over the limit is a `429` carrying `retry-after` and JSON-RPC code `-32005` —
the code wallets already back off on — with the wait in milliseconds in
`error.data.retryAfterMs`. A refused request spends nothing, so a client that
retries hard can still climb out.

The buckets are in memory. That is exact and free for one process, and it means
two processes each allow the configured rate.

## What it costs

Requests are the obvious thing to count and almost the wrong one:

```
warm call (from the shared cache)     9–13 ms   costs nothing
cold call (fetched from the parent)  400–860 ms  a paid request
```

Ten thousand warm calls are cheaper than a hundred cold ones, so both are
counted per environment per day and the miss is the number that matters.
`forkstate_usage` reports them:

```json
{ "total": { "requests": 18422, "misses": 311 },
  "days": [ { "day": "2026-09-07", "requests": 18422, "misses": 311 } ] }
```

Written in batches, never a row per read — the cache exists to stop paying for
round trips, and a meter that spent one per read would cost more than it
measured. Usage that fails to write is kept and retried rather than dropped.

## More than one process

Environments live in memory, so two processes can hold the same one and both
mine on top of the state they loaded. Only one of those can be true afterwards.

Every environment row carries a revision. A write says which revision it is
replacing, and a write built on a revision that is no longer current does not
land: the environment is dropped and the caller gets a `409` saying nothing was
applied and to send it again. Reads take no part in this — they neither queue nor
write.

Within a process, writes to one environment are serialised. Two writes sharing
one in-memory environment have their blocks mixed together before either is
written out, so whichever persists first carries the other's block with it — and
the other would be told it was refused while its block sat on the chain. The
queue is per environment; other environments and all reads run in parallel.

What this buys is that a reported success is real and a reported refusal is real.
What it does not buy is a faster single testnet: concurrent writes to one
environment still happen one at a time, and across processes they conflict.
Traffic spread over many environments scales across processes cleanly, because
each is its own row.

## Six things worth knowing

### `eth_call` was changing state

`RPCStateManager.commit()` commits only the account cache, while `checkpoint()`
and `revert()` act on account, storage and code alike. Every committed EVM frame
therefore left the storage cache one layer deeper than the account cache, and the
layers drifted apart.

From outside that looked like this: simulate a swap through a PancakeSwap pair
and its reentrancy slot came back set, so the next swap — simulated or real —
failed with `Pancake: LOCKED`. Two identical calls answering differently is about
as wrong as a fork can be, and it was invisible until a call happened to touch a
contract that reads back what it wrote.

`ForkStateManager` overrides `commit()` to commit every cache. A test runs the
same swap three times and asserts the slot is untouched each time.

### Fork depth is not limited to a minute

`RPCStateManager` fetches accounts with `eth_getProof`, and a provider serves
proofs only while it still holds the trie. Measured on BNB Chain: proofs work
about **100 blocks** back, which at a 0.16 second block time is under a minute.
Past that it fails with "missing trie node", so a fork pinned to anything older
cannot be restored.

Plain state reads have no such limit. On the same free tier, `eth_getBalance`,
`eth_getCode`, `eth_getTransactionCount` and `eth_getStorageAt` all answered
correctly **ten million blocks** back. `ForkStateManager` assembles the account
from those instead of from a proof, and that one change is the difference between
forking the last minute and forking anywhere.

The proof is not missed: it exists to verify a remote answer, and a devnet that
has already chosen to trust its parent RPC has nothing to check it against.

### Forks snap to a checkpoint so they can share a cache

The parent's state at a block is the same for every environment, so one fork
paying for a read should pay for everyone's. A cache key has to include the block
to be correct — and that makes it useless in the normal case, because every fork
taken at `latest` lands on its own height and shares nothing with its neighbours.

Rounding an unpinned fork down to a multiple of `FORKSTATE_CHECKPOINT` fixes
that. Measured on BNB Chain, four forks created seconds apart:

| | first read | cache |
| --- | --- | --- |
| fork 1 | 1,379 ms | 0 hits, 6 upstream reads |
| fork 2 | 27 ms | 6 hits, **no new upstream reads** |
| fork 3 | 30 ms | 12 hits, none |
| fork 4 | 28 ms | 18 hits, none |

The cost is that a fork is up to `checkpoint` blocks behind the head — 16 seconds
on BNB Chain at the default. Pin `forkBlock` when that matters.

### A forwarded "latest" is the worst bug available

Passing a block tag straight through looks harmless and is not. The parent
resolves `latest` against *its* head, which has moved on since the fork, so
`eth_getBlockTransactionCountByNumber("latest")` came back as 85 — BNB Chain's
current block — for a fork whose latest block held one transaction of its own.
`eth_getTransactionByBlockNumberAndIndex` handed back a stranger's transaction
stamped `chainId: 0x38`. An indexer pointed at the fork would have written down
mainnet as if it were yours.

Anything block-scoped is now answered from the local chain when the block is
ours, and a forwarded call is anchored to the fork block rather than to a tag the
parent gets to interpret. Filters moved in-process for the same reason: a filter
created on the parent watches the parent, so `contract.on(...)` against a fork
was receiving mainnet's events and none of its own.

### Reading the parent is not a write

Read-through goes through the same `putStorage` the overlay watches, so an
unguarded fork records all of mainnet as its own writes and stops being small.
`ForkStateManager` raises a flag while it fills from the parent, and the overlay
ignores anything written under it. A test holds this down: after an `eth_call`
into a token contract, the overlay still has zero slots in it.

### Revert rebuilds the state manager

Undoing writes in place cannot work. A slot the snapshot never mentioned was
being read through to the parent at the time, and there is no value to put back —
writing zero would shadow the parent with a lie. Reverting therefore starts a
fresh state manager and replays the overlay onto it, which restores read-through
for exactly the slots that had it. The read cache is lost, costing some RPC calls
on the next reads; a revert is rare and being wrong is not worth avoiding that.

## Layout

| File | What it holds |
| --- | --- |
| `environment.ts` | One fork: state, execution, snapshots, overlay |
| `state-manager.ts` | Read-through without `eth_getProof` |
| `upstream-cache.ts` | Parent state shared across every environment |
| `overlay.ts` | What an environment has written |
| `chain.ts` | Blocks and receipts produced here |
| `manager.ts` | Every environment this process holds |
| `store.ts` | One row per environment |
| `backend.ts` | SQLite or Postgres, chosen by `DATABASE_URL` |
| `rpc-server.ts` | JSON-RPC, with passthrough to the parent |
| `server.ts` | HTTP and the management API |
| `ui.ts` | The console, as one file with no build step |
| `tracer.ts` | Call trees and opcode steps, from the EVM's own events |
| `sqlite.ts` | The one place Node and Bun differ |
| `limits.ts` | The token bucket, when a rate is configured |
| `verify.ts` | Compiling submitted source and comparing it to the chain |

## Documentation

| | |
| --- | --- |
| [docs/rpc.md](docs/rpc.md) | Every method, including the ones that are not standard |
| [docs/deploying.md](docs/deploying.md) | Running it, locking it down, and where the cost is |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Running the tests, and what a good change looks like |

## License

MIT. See [LICENSE](LICENSE).
