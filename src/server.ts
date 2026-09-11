/**
 * The HTTP front.
 *
 * Each environment gets its own path, so a wallet points at one URL and stays on
 * one fork. The management API sits beside it rather than inside the JSON-RPC
 * surface: creating and deleting environments is not something a dapp should be
 * able to do through the same endpoint it sends transactions to.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StaleEnvironment, type Manager } from "./manager.ts";
import type { Environment } from "./environment.ts";
import type { Meter } from "./meter.ts";
import { UI } from "./ui.ts";
import { limitsFromEnv, RateLimiter } from "./limits.ts";
import { handleRpc } from "./rpc-server.ts";
import { mutating, WriteQueue } from "./write-queue.ts";
import type { Alerts } from "./alerts.ts";
import type { StoredBlock, StoredTx } from "./chain.ts";
import { serveSockets } from "./ws-server.ts";
import { reportError } from "./report.ts";

const MAX_BODY = 8 * 1024 * 1024;

/** Any origin: this is a devnet, and refusing a browser is the only thing CORS could do here. */
const CORS: Record<string, string> = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
};

function body(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reject(new Error("request body too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { ...CORS, "content-type": "application/json" }).end(JSON.stringify(payload));
}

/*
 * The engine has no idea who owns which environment — that is the console's job.
 * So when it is reachable from anywhere, one shared secret decides who may ask
 * it anything at all. Without it, a public URL serves every environment in the
 * process to whoever guesses an eight-character id.
 *
 * Unset means open, which is right for a process bound to localhost or sitting
 * on a private network.
 */
function authorised(request: IncomingMessage, key: string | undefined): boolean {
    if (!key) return true;
    const offered = request.headers["x-forkstate-key"];
    return typeof offered === "string" && offered.length === key.length && timingSafeEqual(
        Buffer.from(offered), Buffer.from(key),
    );
}

/**
 * The methods that can change an environment.
 *
 * Named explicitly because the alternative — noticing afterwards that something
 * changed — is too late: by then another request has already interleaved.
 */
/** Thrown inside the write queue, where returning a response is not possible. */
class NoEnvironment extends Error {
    constructor(id: string) {
        super(`No environment "${id}".`);
    }
}


export function serve(
    manager: Manager, port: number, defaultRpc: string, meter?: Meter, alerts?: Alerts,
) {
    const queue = new WriteQueue();
    // Off unless FORKSTATE_RATE says otherwise, so a local engine behaves the way
    // it always has and a deployed one can be given a ceiling.
    // Read here rather than at module load, so it is set the same way the rate
    // limit is — and so a test can start an engine that actually has one.
    const key = process.env.FORKSTATE_KEY;
    const limiter = new RateLimiter(limitsFromEnv());
    const sweeping = limiter.unlimited ? null : setInterval(() => limiter.sweep(), 60_000);
    sweeping?.unref?.();
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
            const url = new URL(req.url ?? "/", "http://localhost");
            const path = url.pathname.replace(/\/+$/, "") || "/";

            if (req.method === "OPTIONS") {
                res.writeHead(204, CORS).end();
                return;
            }

            /*
             * The one thing answered without a key.
             *
             * A host that cannot tell whether a process is wedged cannot restart
             * it, and every other endpoint needs the header — so a deployment
             * with a key set had no healthcheck at all. This says only that the
             * event loop is still turning, which is what a healthcheck is for and
             * is not worth protecting.
             */
            if (path === "/health" && req.method === "GET") {
                return send(res, 200, { ok: true });
            }

            if (!authorised(req, key)) {
                return send(res, 401, { error: "This engine requires x-forkstate-key." });
            }

            try {
                if (path === "/" && req.method === "GET") {
                    // A browser cannot send the header, and a console in front of
                    // this is the interface in that deployment anyway.
                    if (key) return send(res, 404, { error: "Not found" });
                    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(UI);
                    return;
                }

                // ---- management
                if (path === "/environments" && req.method === "GET") {
                    return send(res, 200, { environments: await manager.list(), live: manager.liveCount() });
                }

                if (path === "/environments" && req.method === "POST") {
                    const options = JSON.parse((await body(req)) || "{}") as Record<string, unknown>;
                    const created = await manager.create({
                        rpcUrl: String(options.rpcUrl ?? defaultRpc),
                        name: options.name as string | undefined,
                        chainId: options.chainId === undefined ? undefined : Number(options.chainId),
                        forkBlock: options.forkBlock === undefined ? undefined : BigInt(String(options.forkBlock)),
                        checkpoint: options.checkpoint === undefined ? undefined : Number(options.checkpoint),
                        followHead: options.followHead === undefined ? undefined : Boolean(options.followHead),
                    });
                    return send(res, 201, {
                        id: created.id,
                        rpcUrl: `http://127.0.0.1:${port}/${created.id}`,
                        chainId: created.env.chainId,
                        forkBlock: "0x" + created.env.forkBlock.toString(16),
                        followsHead: created.env.followsHead,
                    });
                }

                const single = /^\/environments\/([0-9a-f-]+)$/.exec(path);
                if (single?.[1] && req.method === "DELETE") {
                    return send(res, 200, { deleted: await manager.delete(single[1]) });
                }

                /*
                 * Stopping an environment without deleting it.
                 *
                 * The engine does not know about money; whoever runs it does,
                 * and uses this to stop an account that has run out. Its state
                 * is kept exactly as it was, and lifting the suspension brings
                 * it back as if nothing happened.
                 */
                const suspending = /^\/environments\/([0-9a-f-]+|default)\/suspension$/.exec(path);
                if (suspending?.[1]) {
                    const target = suspending[1];
                    if (req.method === "GET") {
                        return send(res, 200, { suspension: await manager.suspension(target) });
                    }
                    if (req.method === "PUT") {
                        const options = JSON.parse((await body(req)) || "{}") as { reason?: unknown };
                        const reason = String(options.reason ?? "").trim() || "This testnet is suspended.";
                        await manager.setSuspension(target, reason.slice(0, 200));
                        return send(res, 200, { suspended: true });
                    }
                    if (req.method === "DELETE") {
                        await manager.setSuspension(target, null);
                        return send(res, 200, { suspended: false });
                    }
                }

                // ---- JSON-RPC, one environment per path
                if (req.method === "POST") {
                    const id = path === "/" ? "default" : path.slice(1);
                    const payload = JSON.parse(await body(req)) as unknown;

                    // Before metering or limiting: a suspended environment does
                    // no work, so there is nothing to count.
                    const stopped = await manager.suspension(id);
                    if (stopped) {
                        return send(res, 402, {
                            jsonrpc: "2.0",
                            id: null,
                            // The code a node uses when it will not do the work,
                            // and the one the console's own refusal already uses.
                            error: { code: -32005, message: stopped.reason },
                        });
                    }

                    // Charged per call, so a batch costs what it actually is.
                    const cost = Array.isArray(payload) ? Math.max(payload.length, 1) : 1;
                    meter?.request(id, cost);
                    const allowed = limiter.take(id, cost);
                    if (!allowed.ok) {
                        res.setHeader("retry-after", Math.ceil(allowed.retryAfter / 1000));
                        return send(res, 429, {
                            jsonrpc: "2.0",
                            id: null,
                            error: {
                                // The code Ethereum clients already use for this, so
                                // a wallet backs off instead of reporting a failure.
                                code: -32005,
                                message: "This testnet is over its request limit.",
                                data: { retryAfterMs: allowed.retryAfter },
                            },
                        });
                    }

                    // Batches are how wallets and indexers actually talk; answering one
                    // at a time makes them look broken rather than slow.
                    const context = { id, alerts };
                    const run = async (env: Environment) => (Array.isArray(payload)
                        ? await Promise.all(payload.map((one) =>
                            handleRpc(env, one as Record<string, unknown>, context)))
                        : await handleRpc(env, payload as Record<string, unknown>, context));

                    if (!mutating(payload)) {
                        // Reads change nothing, so they neither queue nor persist.
                        const env = await manager.get(id);
                        if (!env) return send(res, 404, { error: `No environment "${id}".` });
                        return send(res, 200, await run(env));
                    }

                    try {
                        /*
                         * The environment is fetched inside the queue, not before
                         * it: a write ahead of this one may have lost and dropped
                         * it, and running against the copy that was dropped would
                         * build on state that is no longer there.
                         */
                        const result = await queue.run(id, async () => {
                            const env = await manager.get(id);
                            if (!env) throw new NoEnvironment(id);

                            /*
                             * Blocks are collected, not announced.
                             *
                             * An alert must describe something that happened. A
                             * block that loses its write is thrown away, and a
                             * webhook that had already gone out would be reporting
                             * a transaction nobody can find.
                             */
                            const mined: Array<[ StoredBlock, StoredTx[] ]> = [];
                            const stop = alerts ? env.watch((b, t) => { mined.push([ b, t ]); }) : null;
                            let answer;
                            try {
                                answer = await run(env);
                            } finally {
                                stop?.();
                            }

                            /*
                             * Only when something actually changed, and before the
                             * reply rather than after: if the write loses to another
                             * process the caller must hear about it instead of a
                             * receipt for a transaction that was thrown away.
                             */
                            await manager.persist(id, env);
                            for (const [ block, txs ] of mined) {
                                alerts!.dispatch(id, env.chainId, block, txs);
                            }
                            return answer;
                        });
                        return send(res, 200, result);
                    } catch (error) {
                        if (error instanceof NoEnvironment) {
                            return send(res, 404, { error: `No environment "${id}".` });
                        }
                        if (!(error instanceof StaleEnvironment)) throw error;
                        return send(res, 409, {
                            jsonrpc: "2.0",
                            id: null,
                            error: {
                                // Not a client mistake and not a broken node: the
                                // same request sent again will work, because the
                                // environment is reloaded before it runs.
                                code: -32000,
                                message: "This testnet was changed elsewhere; nothing was applied. "
                                    + "Send it again.",
                            },
                        });
                    }
                }

                send(res, 404, { error: "Not found" });
            } catch (error) {
                /*
                 * The caller's fault or ours, said as which.
                 *
                 * Everything used to come back as a 400 parse error, so a
                 * database that stopped answering looked to a client — and to
                 * monitoring — like a malformed request. Only JSON that will not
                 * parse, or a body too large, is the caller's.
                 */
                const theirs = error instanceof SyntaxError
                    || (error instanceof Error && error.message === "request body too large");
                if (theirs) {
                    return send(res, 400, {
                        jsonrpc: "2.0", id: null,
                        error: { code: -32700, message: error instanceof Error ? error.message : "bad request" },
                    });
                }
                reportError(`request to ${path} failed`, error);
                send(res, 500, {
                    jsonrpc: "2.0", id: null,
                    error: { code: -32603, message: "The engine hit an error answering this. It has been reported." },
                });
            }
        })();
    });

    /*
     * The socket endpoint, on the same port.
     *
     * Given the same queue, so a transaction sent over a socket cannot land in
     * the middle of one sent over HTTP, and the same limiter, so a socket is a
     * cheaper way to ask rather than a free one.
     */
    const websockets = serveSockets({ server, manager, key, limiter, meter, queue, alerts });
    server.on("close", () => websockets.close());

    server.listen(port);
    return server;
}
