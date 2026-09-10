# The RPC surface

Every environment is one path on the same port. `POST /<id>`, or `POST /` for the
preset `default`. Batches are answered as batches.

```bash
curl -s localhost:8546/7105ce1d \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

Anything not listed here is forwarded to the parent chain, which is where the
history from before the fork lives.

## Beyond the standard

### `eth_call` with state overrides

The third parameter is Geth's, and is a map of address to the fields to pretend
about. It applies for that one call: the call already runs inside a checkpoint
that is thrown away, and the overrides go inside it.

```json
["0x…", "latest", {
  "0x55d398326f99059fF775485246999027B3197955": {
    "stateDiff": { "0x<slot>": "0x<32-byte value>" }
  },
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266": { "balance": "0x…" }
}]
```

`balance`, `nonce`, `code` and `stateDiff` are honoured. Geth's `state` — which
means "the storage is exactly this and every other slot is zero" — is refused
with an error saying so, because a fork cannot enumerate the slots it would have
to blank.

`debug_traceCall` takes the same thing as `stateOverrides` inside its options.

### A failed receipt says why

`eth_getTransactionReceipt` adds two fields when `status` is `0x0`:

| Field | What it is |
| --- | --- |
| `revertReason` | A sentence where one can be had |
| `revertData` | The bytes the revert returned, untouched |

`Error(string)` becomes the string the contract wrote. `Panic(uint256)` is named
— "arithmetic overflow or underflow" rather than `0x11`. A custom error is
reported as `reverted with custom error 0x1234abcd`, because naming it needs the
ABI, which the engine does not have; `revertData` carries the arguments for
whoever does.

### Tracing

| Method | Returns |
| --- | --- |
| `debug_traceCall` | The call tree of a call that is never committed |
| `debug_traceTransaction` | The tree kept from when a transaction ran here |

Both return `callTree`, and `debug_traceTransaction` also returns `stateDiff`.
Opcode entries are opt-in, because one swap is tens of thousands of them:

```json
["0x…", "latest", {
  "tracer": "structLogger",
  "tracerConfig": { "opcodes": "relevant", "limit": 2000, "withStack": true }
}]
```

`opcodes` names a set — `relevant`, `storage`, `calls`, `logs`, `memory` —
filtered before the limit applies, so the limit means "this many of the ones you
asked for".

Traces are kept beside the environment, so they survive a restart.

### Simulating several transactions at once

`forkstate_simulateBundle` runs transactions in order, each on top of what the
one before it did, and throws all of it away. An approve followed by a swap is
two `eth_call`s that fail separately and one bundle that works.

```json
[{
  "transactions": [
    { "from": "0x…", "to": "0xUSDT", "data": "0x095ea7b3…" },
    { "from": "0x…", "to": "0xRouter", "data": "0x38ed1739…" }
  ],
  "overrides": { "0xUSDT": { "stateDiff": { "0x…": "0x…" } } },
  "trace": true,
  "diff": true
}]
```

A bare array of transactions works too. `overrides` are applied once, before the
first transaction, and are the same shape `eth_call` takes.

Each result carries `index`, `from`, `to`, `status`, `gasUsed`, `returnValue`,
`error`, `revertData`, `contractAddress` and `logs`; `trace` adds `callTree`,
`diff` adds `stateDiff`, both under the names `debug_traceTransaction` uses.
The bundle itself reports total `gasUsed` and whether any transaction `failed`.

One that reverts is undone on its own — the ones before it stand, and the ones
after it still run, so a caller who sent five transactions hears about five. A
reverted transaction still spends its nonce, as it would on a chain, and gets no
`stateDiff`, because its writes were undone; its `callTree` is where you see
what it tried. Nothing is mined and nothing reaches the overlay. Up to 64
transactions per bundle.

### Subscriptions

Open the same URL with `ws://` or `wss://` and `eth_subscribe` works:

```js
const provider = new ethers.WebSocketProvider(wsUrl);
provider.on("block", (n) => console.log(n));
```

| Subscription | Sends |
| --- | --- |
| `newHeads` | The header of every block this fork mines |
| `logs` | Logs matching `{ address, topics }` |
| `newPendingTransactions` | The hash of each transaction |

`topics` is positional, and each position may be a topic, `null` for anything,
or a list of alternatives — `[[transfer, approval]]` is "either of these".
`eth_getLogs` and a subscription use the same matcher, so backfilling with one
and following with the other cannot disagree.

A fork mines as it receives, so nothing stays pending: `newPendingTransactions`
fires when the block is made, which is a beat later than a real chain and is
what the subscriber was waiting for either way.

The socket answers ordinary calls too, so one connection is enough. Writes sent
over it queue with the ones sent over HTTP and are written out before the reply,
exactly as they are there. A ping every 30 seconds keeps an idle subscription
from being dropped by something in the middle.

A deployed engine has a key, and a browser cannot put a header on a WebSocket
handshake. So the console signs one environment id and an expiry and appends
`?exp=…&sig=…`; the engine checks it. The result is a URL that can be handed to
a wallet: it opens one environment, cannot be edited into another, and expires.

### Cheatcodes

`anvil_setBalance`, `anvil_setNonce`, `anvil_setCode`, `anvil_setStorageAt`,
`anvil_impersonateAccount`, `anvil_stopImpersonatingAccount`,
`anvil_autoImpersonateAccount`, `anvil_mine`, `evm_mine`, `evm_increaseTime`,
`evm_snapshot`, `evm_revert`.

`forkstate_setTokenBalance(token, holder, amount)` finds where a token keeps its
balances and writes one. There is no standard way to ask a contract that, so the
slot is searched for; the probes are not recorded, so a failed search leaves the
overlay as it was.

### About the fork itself

| Method | Answers |
| --- | --- |
| `forkstate_info` | Chain id, fork block, size, whether it follows the head |
| `forkstate_overlay` | Everything this environment has written |
| `forkstate_size` | How many accounts and slots that is |
| `forkstate_cache` | How much parent state is cached, across every environment |
| `forkstate_contracts` | Addresses this environment has code at |
| `forkstate_sync` | Move a following fork to the parent's head now |
| `forkstate_followHead` | Turn head-following on or off |
| `forkstate_setChainId` | Change the id; signatures follow it |
| `forkstate_usage` | Requests and cold reads, per day — takes a number of days, default 30 |

### Verification

`forkstate_verify` takes a request shaped like Etherscan's and returns a `guid`;
`forkstate_verifyStatus` reports on it. Both `solidity-single-file` and
`solidity-standard-json-input` are accepted. The compiler is downloaded once and
run in its own process, so a compile cannot stall the environments being served
alongside it.

## Refused, and why

| Method | Why not |
| --- | --- |
| `eth_getProof` | The parent's proof is a signed claim that this fork's writes do not exist |
| `eth_sign`, `eth_signTransaction` | No key is ever held here — sign in your wallet, send the raw transaction |

## Errors worth handling

| Code | HTTP | Meaning |
| --- | --- | --- |
| `-32005` | 429 | Over the request limit. `error.data.retryAfterMs` says how long |
| `-32000` | 409 | Another process wrote this environment; nothing was applied. Send it again |
