# Deploying it

The engine needs a process that stays alive. Environments live in memory and the
head-sync runs on a timer, so anything that ends the process with the request —
Vercel, Lambda — will not do. Any container host will.

## The smallest thing that works

```bash
docker build -t forkstate .
docker run -p 8546:8546 \
  -e FORKSTATE_RPC=https://your-archive-node \
  -e FORKSTATE_KEY=$(openssl rand -hex 32) \
  forkstate
```

The image is about 140 MB and idles around 34 MB.

## With Postgres instead of a disk

Set `DATABASE_URL` and nothing is written to disk — environments and the shared
parent cache both go to Postgres, so no volume has to be arranged. That is what
makes it deployable on hosts that would rather not give you one.

It costs a slower cold start, measured on the same swap:

| | first call | cold start | warm |
| --- | --- | --- | --- |
| SQLite on a disk | 3.2 s | 185 ms | 7 ms |
| Postgres, no disk | 3.6 s | 1.08 s | 12 ms |
| no cache at all | 3.6 s | 3.6 s | 3.6 s |

A pooled connection string is detected and prepared statements are turned off for
it, because a transaction pooler cannot hold them between statements.

## Locking it down

The engine has no idea who owns what. That is deliberate — it stays a node, and
whatever sits in front decides who may touch which environment. The consequence
is that a publicly reachable engine will serve every environment in the process
to anyone who guesses an eight-character id.

So when it is reachable from outside:

```bash
FORKSTATE_KEY=…    # required in an x-forkstate-key header on every request
FORKSTATE_RATE=25  # requests per second, per environment
FORKSTATE_BURST=100
```

The built-in UI is not served when a key is set: a browser cannot send a header,
and in that deployment the thing in front is the interface.

## Where the cost actually is

Almost none of it is compute. The engine's own work on a warm call is around two
milliseconds; a cold one is four hundred to eight hundred, nearly all of it
waiting on the parent chain.

```
cold call (fetched from the parent)   400–860 ms
warm call (served from the cache)       9–13 ms
```

So the number worth metering is cache misses, not requests. The cache is keyed by
chain, block, kind, address and slot, and is shared by every environment in the
process — which is why forks are rounded down to a checkpoint by default, so that
two forks taken minutes apart share one.

## Running more than one

Safe, with two things to know.

A write that was built on a version of the environment that is no longer current
does not land: the caller gets a `409` and should send it again. And the rate
limiter is per process, so two processes each allow the configured rate.

Traffic spread across many environments scales cleanly, because each environment
is its own row. Concurrent writes to a *single* environment do not: they are
serialised within a process and conflict across processes. If one testnet is
being hammered with parallel transactions, one process serves it better than two.

## Health

`GET /health` answers `{"ok":true}` without a key. It is the one endpoint that
does: a host that cannot tell whether a process is wedged cannot restart it, and
everything else needs the header, so an engine with a key set would otherwise
have no healthcheck at all. It reports liveness and nothing else.

`GET /environments`, with the key, returns every environment and how many are
held in memory — the same thing plus the detail, for a human.
