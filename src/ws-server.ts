/*
 * Subscriptions, over a socket.
 *
 * Everything else this engine serves is a question and an answer. This is the
 * one thing a client cannot ask for over HTTP: "tell me when something happens".
 * Wallets, indexers and `ethers.WebSocketProvider` all expect `eth_subscribe`,
 * and polling `eth_getFilterChanges` in its place is both slower and, on a fork
 * that mines a block per transaction, a request per second forever.
 *
 * The socket speaks the same JSON-RPC as the HTTP endpoint — the same handler,
 * the same environment — with `eth_subscribe` and `eth_unsubscribe` added and a
 * push channel underneath.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import type { Manager } from "./manager.ts";
import type { Environment } from "./environment.ts";
import type { StoredBlock, StoredTx } from "./chain.ts";
import { handleRpc } from "./rpc-server.ts";
import { logMatches, type LogFilter } from "./logs.ts";
import type { RateLimiter } from "./limits.ts";
import type { Meter } from "./meter.ts";
import { mutating, type WriteQueue } from "./write-queue.ts";
import type { Alerts } from "./alerts.ts";
import { StaleEnvironment } from "./manager.ts";

/**
 * How long a socket may go quiet before it is assumed dead.
 *
 * A subscription is a connection that is supposed to be idle, which is exactly
 * the kind a proxy silently drops: the client keeps waiting for events that will
 * never arrive because nothing is on the other end any more. A ping every 30
 * seconds keeps it open and, more usefully, notices when it is not.
 */
const HEARTBEAT_MS = 30_000;

/**
 * The most subscriptions one socket may hold.
 *
 * Each one is a filter evaluated against every log of every block, so this is a
 * ceiling on work a single connection can ask for, not on memory.
 */
const MAX_SUBSCRIPTIONS = 64;

/** What a subscription is watching. */
type Kind = "newHeads" | "logs" | "newPendingTransactions";

interface Subscription {
    id: string;
    kind: Kind;
    filter: LogFilter;
}

/**
 * A URL that proves the bearer was told about this environment.
 *
 * A browser cannot put a header on a WebSocket handshake, so the key that
 * protects every HTTP route is not available here. Instead the console — which
 * holds the same key — signs one environment id and an expiry, and this checks
 * the signature. The result is a URL that can be handed to a wallet: it opens
 * one environment, it cannot be edited into another, and it stops working.
 */
export function signSocketUrl(key: string, envId: string, expiresAt: number): string {
    const signature = createHmac("sha256", key).update(`${envId}.${expiresAt}`).digest("base64url");
    return `exp=${expiresAt}&sig=${signature}`;
}

function signatureValid(key: string, envId: string, exp: string | null, sig: string | null): boolean {
    if (!exp || !sig) return false;
    const expiresAt = Number(exp);
    if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) return false;

    const expected = Buffer.from(
        createHmac("sha256", key).update(`${envId}.${expiresAt}`).digest("base64url"),
    );
    const given = Buffer.from(sig);
    // Same length first: timingSafeEqual throws on a mismatch, and throwing on a
    // wrong-length signature would be a length oracle by way of a 500.
    return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The block header, shaped the way a client expects `newHeads` to be. */
function headerFor(block: StoredBlock, chainId: number): Record<string, unknown> {
    return {
        number: "0x" + block.number.toString(16),
        hash: block.hash,
        parentHash: block.parentHash,
        timestamp: "0x" + block.timestamp.toString(16),
        gasUsed: block.gasUsed,
        gasLimit: block.gasLimit,
        baseFeePerGas: block.baseFeePerGas,
        miner: block.miner,
        difficulty: "0x0",
        extraData: "0x",
        nonce: "0x0000000000000000",
        mixHash: "0x" + "0".repeat(64),
        sha3Uncles: "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347",
        logsBloom: "0x" + "0".repeat(512),
        stateRoot: "0x" + "0".repeat(64),
        transactionsRoot: "0x" + "0".repeat(64),
        receiptsRoot: "0x" + "0".repeat(64),
        withdrawalsRoot: "0x" + "0".repeat(64),
        blobGasUsed: "0x0",
        excessBlobGas: "0x0",
        parentBeaconBlockRoot: "0x" + "0".repeat(64),
        // Deliberately no `transactions`: a header is what this event carries,
        // and a client that wants the body asks for the block.
        chainId: "0x" + chainId.toString(16),
    };
}

/**
 * Attaches the socket endpoint to a server that is already serving HTTP.
 *
 * One port, two protocols. Splitting them would mean a second port to expose, a
 * second thing to health-check, and a URL that differs from the HTTP one by more
 * than its scheme.
 */
export function serveSockets(options: {
    server: Server;
    manager: Manager;
    key?: string;
    limiter?: RateLimiter;
    meter?: Meter;
    /** The HTTP side's queue. Shared, or the two paths can write over each other. */
    queue: WriteQueue;
    alerts?: Alerts;
}): { close(): void } {
    const { server, manager, key, limiter, meter, queue, alerts } = options;
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const id = url.pathname.replace(/\/+$/, "").slice(1) || "default";

        /*
         * Two ways in, for two kinds of caller.
         *
         * A server holding the engine key sends it as a header, exactly as it
         * would over HTTP. A browser cannot, so it brings a signature over the
         * environment id instead. An engine with no key set is a local one, and
         * is open the same way its HTTP side is.
         */
        const authorised = !key
            || request.headers["x-forkstate-key"] === key
            || signatureValid(key, id, url.searchParams.get("exp"), url.searchParams.get("sig"));

        if (!authorised) {
            socket.write("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
            socket.destroy();
            return;
        }

        void (async () => {
            /*
             * Resolved before the handshake completes.
             *
             * Upgrading and then closing tells the client only that the socket
             * shut, which every library reports as a network problem. Refusing
             * the upgrade gives it an HTTP status it can print.
             */
            const env = await manager.get(id);
            if (!env) {
                socket.write("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
                socket.destroy();
                return;
            }
            sockets.handleUpgrade(request, socket, head, (client) => {
                attach(client, id, env);
            });
        })();
    });

    function attach(client: WebSocket, id: string, env: Environment): void {
        const subscriptions = new Map<string, Subscription>();
        let nextId = 1;
        let alive = true;

        const send = (payload: unknown) => {
            if (client.readyState === client.OPEN) client.send(JSON.stringify(payload));
        };

        const push = (subscription: string, result: unknown) => send({
            jsonrpc: "2.0",
            method: "eth_subscription",
            params: { subscription, result },
        });

        const onBlock = (block: StoredBlock, txs: StoredTx[]) => {
            for (const subscription of subscriptions.values()) {
                if (subscription.kind === "newHeads") {
                    push(subscription.id, headerFor(block, env.chainId));
                } else if (subscription.kind === "newPendingTransactions") {
                    /*
                     * A fork mines as it receives, so nothing is ever pending for
                     * long enough to announce separately. Announcing at the block
                     * is a beat late by the standard's reckoning and is what the
                     * subscriber is actually waiting for — the alternative is a
                     * subscription that never fires.
                     */
                    for (const tx of txs) push(subscription.id, tx.hash);
                } else {
                    for (const tx of txs) {
                        for (const log of tx.logs) {
                            if (logMatches(log, subscription.filter)) push(subscription.id, log);
                        }
                    }
                }
            }
        };

        /*
         * The watcher follows the environment, not the object.
         *
         * An environment is dropped and rebuilt when another replica wins a write
         * or when it is evicted, and a listener attached to the copy that went
         * away stops hearing about blocks without stopping being a subscription.
         * The client sees a chain that has gone quiet, which is the worst
         * possible failure for something an indexer is trusting.
         */
        let watched: Environment = env;
        let stopWatching = env.watch(onBlock);
        const rewatch = async () => {
            const live = await manager.get(id);
            if (!live || live === watched) return live;
            stopWatching();
            watched = live;
            stopWatching = live.watch(onBlock);
            return live;
        };

        const heartbeat = setInterval(() => {
            if (!alive) {
                client.terminate();
                return;
            }
            alive = false;
            client.ping();
            // Cheap, and bounds how long a re-created environment can go
            // unnoticed by a subscription that is otherwise idle.
            if (subscriptions.size > 0) void rewatch();
        }, HEARTBEAT_MS);
        heartbeat.unref?.();

        client.on("pong", () => { alive = true; });

        client.on("message", (raw) => {
            void (async () => {
                let request: { id?: unknown; method?: unknown; params?: unknown[] };
                try {
                    request = JSON.parse(String(raw)) as typeof request;
                } catch {
                    return send({
                        jsonrpc: "2.0", id: null,
                        error: { code: -32700, message: "That is not JSON." },
                    });
                }

                const answer = (result: unknown) => send({ jsonrpc: "2.0", id: request.id ?? null, result });
                const refuse = (code: number, message: string, data?: unknown) => send({
                    jsonrpc: "2.0", id: request.id ?? null, error: { code, message, ...(data ? { data } : {}) },
                });

                // Counted and limited exactly as an HTTP call is; a socket is a
                // cheaper way to ask, not a free one.
                meter?.request(id, 1);
                const allowed = limiter?.take(id, 1);
                if (allowed && !allowed.ok) {
                    return refuse(-32005, "This testnet is over its request limit.", {
                        retryAfterMs: allowed.retryAfter,
                    });
                }

                const method = String(request.method ?? "");
                const params = Array.isArray(request.params) ? request.params : [];

                if (method === "eth_subscribe") {
                    const kind = String(params[0] ?? "") as Kind;
                    if (kind !== "newHeads" && kind !== "logs" && kind !== "newPendingTransactions") {
                        return refuse(-32602, `Cannot subscribe to "${kind}". This engine has `
                            + "newHeads, logs and newPendingTransactions.");
                    }
                    if (subscriptions.size >= MAX_SUBSCRIPTIONS) {
                        return refuse(-32005, `One connection may hold ${MAX_SUBSCRIPTIONS} `
                            + "subscriptions. Unsubscribe from something first.");
                    }
                    const criteria = (kind === "logs" ? params[1] ?? {} : {}) as LogFilter;
                    const subscription = "0x" + (nextId++).toString(16).padStart(16, "0");
                    subscriptions.set(subscription, { id: subscription, kind, filter: criteria });
                    return answer(subscription);
                }

                if (method === "eth_unsubscribe") {
                    return answer(subscriptions.delete(String(params[0] ?? "")));
                }

                /*
                 * Everything else is the ordinary RPC surface.
                 *
                 * The environment is re-fetched per message rather than captured
                 * once: a write from another process can lose this one its copy,
                 * and answering from the copy that was dropped is how a client
                 * gets told about state that no longer exists.
                 */
                try {
                    if (!mutating(request)) {
                        const live = await manager.get(id);
                        if (!live) return refuse(-32000, `No environment "${id}".`);
                        return send(await handleRpc(live, request as Record<string, unknown>,
                            { id, alerts }));
                    }

                    // Writes queue with the HTTP side's, and persist before the
                    // reply: a client must not be handed a receipt for a block
                    // that lost to another process and was thrown away.
                    const answer = await queue.run(id, async () => {
                        const live = await rewatch();
                        if (!live) throw new StaleEnvironment(id);
                        // Collected and announced only after the write is out —
                        // the same rule the HTTP side follows, and for the same
                        // reason: an alert must describe something that happened.
                        const mined: Array<[ StoredBlock, StoredTx[] ]> = [];
                        const stop = alerts ? live.watch((b, t) => { mined.push([ b, t ]); }) : null;
                        let result;
                        try {
                            result = await handleRpc(live, request as Record<string, unknown>,
                                { id, alerts });
                        } finally {
                            stop?.();
                        }
                        await manager.persist(id, live);
                        for (const [ block, txs ] of mined) {
                            alerts!.dispatch(id, live.chainId, block, txs);
                        }
                        return result;
                    });
                    send(answer);
                } catch (error) {
                    if (error instanceof StaleEnvironment) {
                        return refuse(-32000, "This testnet was changed elsewhere; nothing was "
                            + "applied. Send it again.");
                    }
                    refuse(-32603, error instanceof Error ? error.message : String(error));
                }
            })();
        });

        const shut = () => {
            clearInterval(heartbeat);
            stopWatching();
            subscriptions.clear();
        };
        client.on("close", shut);
        client.on("error", shut);
    }

    return {
        close() {
            for (const client of sockets.clients) client.terminate();
            sockets.close();
        },
    };
}
