# Contributing

## Running the tests

```bash
export FORKSTATE_RPC=https://your-archive-node   # required: the suite forks a real chain
npm test
```

They fork BNB Smart Chain and read real contracts, so they need a real archive
node and they are not fast. That is deliberate: nearly every hard bug this
project has had was interop — a field a tool needed and did not get — and a suite
against a mock would have passed through all of them.

Against Postgres as well, which is what a deployment runs:

```bash
docker run -d --rm -e POSTGRES_PASSWORD=test -e POSTGRES_DB=forkstate \
  -p 55432:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/forkstate npm test
```

Both backends must pass. `npm run typecheck` must be clean.

## What a good change looks like

Comments explain *why*, not what. Most of the comments in here name the bug that
made the line necessary, because that is the thing a reader cannot recover from
the code. If you fix something subtle, leave the reason behind.

A new behaviour comes with a test that would fail without it. Prefer a test that
asserts the negative — what must *not* happen — for anything to do with state:
those are the failures nobody notices.

Refuse rather than guess. There are several places here that return an error
saying what they cannot do — a whole-storage override, an ABI type the encoder
will not encode, `eth_getProof`. An answer that is confidently wrong is worse
than no answer.

## Reporting a bug

The useful ones name the tool: what you ran, against which chain, and what the
tool said. `forkstate_info` and `forkstate_overlay` describe the environment's
state exactly and are usually enough to reproduce it.
