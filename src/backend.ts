/**
 * Where the engine keeps what it has to survive a restart.
 *
 * Two backends, chosen by whether `DATABASE_URL` is set:
 *
 *   - **SQLite on a local disk**, which is the fast one. A cold start reads its
 *     cache from the same machine: measured at 185 ms against 3.2 seconds with
 *     no cache at all.
 *   - **Postgres**, which is the portable one. Nothing is written to disk, so the
 *     engine runs on any host that can keep a process alive — no volume, and no
 *     platform that has to support one.
 *
 * The interface is deliberately four methods wide. Anything larger would tempt
 * one backend into behaviour the other cannot match.
 */
import postgres from "postgres";

import { openDatabase, type Database } from "./sqlite.ts";

export interface SavedRow {
    id: string;
    name: string;
    rpcUrl: string;
    chainId: number;
    forkBlock: string;
    createdAt: number;
    updatedAt: number;
    overlay: string;
    chain: string;
    followsHead: boolean;
    /**
     * Which version of this row the writer believes it is replacing.
     *
     * Two processes can hold the same environment — that is the whole point of
     * running more than one — and both will happily mine a block on top of the
     * state they loaded. Without this the second write simply overwrites the
     * first, and a transaction that was accepted, receipted and reported quietly
     * stops existing. With it the second write fails instead, which can be told
     * to the caller.
     */
    revision: number;
}

export interface Backend {
    loadEnvironment(id: string): Promise<SavedRow | null>;
    /**
     * Writes a row, if nobody else has written it since.
     *
     * Returns false when someone has — the caller's copy is behind, and what it
     * would write is built on state that is no longer current.
     */
    saveEnvironment(row: SavedRow): Promise<boolean>;
    listEnvironments(): Promise<SavedRow[]>;
    deleteEnvironment(id: string): Promise<boolean>;

    /**
     * A transaction's trace and state diff, kept apart from the environment row.
     *
     * They belong to one transaction and never change again, while the row is
     * rewritten on every block — putting them there would mean rewriting every
     * trace the environment has ever produced each time anything happens.
     */
    saveTrace(envId: string, hash: string, trace: string, diff: string): Promise<void>;
    loadTrace(envId: string, hash: string): Promise<{ trace: string; diff: string } | null>;
    deleteTraces(envId: string): Promise<void>;

    cacheGet(key: string): Promise<string | null>;
    /** Written in one round trip: a cold call misses dozens of keys at once. */
    cachePut(entries: Array<[string, string]>): Promise<void>;
    cacheCount(): Promise<number>;

    close(): Promise<void>;
}

// ---- SQLite -----------------------------------------------------------------

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS environments (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    rpc_url      TEXT NOT NULL,
    chain_id     INTEGER NOT NULL,
    fork_block   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    overlay      TEXT NOT NULL,
    chain        TEXT NOT NULL,
    follows_head INTEGER NOT NULL DEFAULT 0,
    revision     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS environments_updated ON environments (updated_at DESC);
CREATE TABLE IF NOT EXISTS upstream (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL,
    seen   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS upstream_seen ON upstream (seen);
CREATE TABLE IF NOT EXISTS traces (
    env_id  TEXT NOT NULL,
    hash    TEXT NOT NULL,
    trace   TEXT NOT NULL,
    diff    TEXT NOT NULL,
    PRIMARY KEY (env_id, hash)
);
`;

const fromSqlite = (row: Record<string, unknown>): SavedRow => ({
    revision: Number(row.revision ?? 0),
    id: String(row.id),
    name: String(row.name),
    rpcUrl: String(row.rpc_url),
    chainId: Number(row.chain_id),
    forkBlock: String(row.fork_block),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    overlay: String(row.overlay),
    chain: String(row.chain),
    followsHead: Number(row.follows_head) === 1,
});

class SqliteBackend implements Backend {
    private readonly db: Database;

    constructor(db: Database) {
        this.db = db;
    }

    static async open(path: string): Promise<SqliteBackend> {
        const db = await openDatabase(path);
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA synchronous = NORMAL");
        db.exec(SQLITE_SCHEMA);
        // Added after the first release; a database written by an older build
        // does not have it.
        const columns = new Set((db.prepare("PRAGMA table_info(environments)").all() as
            Array<{ name: string }>).map((c) => c.name));
        if (!columns.has("follows_head")) {
            db.exec("ALTER TABLE environments ADD COLUMN follows_head INTEGER NOT NULL DEFAULT 0");
        }
        if (!columns.has("revision")) {
            db.exec("ALTER TABLE environments ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
        }
        return new SqliteBackend(db);
    }

    async loadEnvironment(id: string) {
        const row = this.db.prepare("SELECT * FROM environments WHERE id = ?").get(id);
        return row ? fromSqlite(row) : null;
    }

    async saveEnvironment(row: SavedRow) {
        // `revision + 1` in the row, and the one being replaced in the WHERE, so
        // two writers racing on the same row cannot both succeed.
        const changed = this.db.prepare(`
            INSERT INTO environments
                (id, name, rpc_url, chain_id, fork_block, created_at, updated_at,
                 overlay, chain, follows_head, revision)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name, updated_at = excluded.updated_at,
                overlay = excluded.overlay, chain = excluded.chain,
                fork_block = excluded.fork_block, follows_head = excluded.follows_head,
                revision = excluded.revision
            WHERE environments.revision = ?`)
            .run(row.id, row.name, row.rpcUrl, row.chainId, row.forkBlock,
                row.createdAt, row.updatedAt, row.overlay, row.chain, row.followsHead ? 1 : 0,
                row.revision + 1, row.revision);
        return Number(changed.changes) > 0;
    }

    async listEnvironments() {
        return (this.db.prepare("SELECT * FROM environments ORDER BY updated_at DESC").all())
            .map(fromSqlite);
    }

    async deleteEnvironment(id: string) {
        return Number(this.db.prepare("DELETE FROM environments WHERE id = ?").run(id).changes) > 0;
    }

    async saveTrace(envId: string, hash: string, trace: string, diff: string) {
        this.db.prepare(
            "INSERT OR REPLACE INTO traces (env_id, hash, trace, diff) VALUES (?, ?, ?, ?)")
            .run(envId, hash, trace, diff);
    }

    async loadTrace(envId: string, hash: string) {
        const row = this.db.prepare(
            "SELECT trace, diff FROM traces WHERE env_id = ? AND hash = ?").get(envId, hash) as
            { trace: string; diff: string } | undefined;
        return row ? { trace: row.trace, diff: row.diff } : null;
    }

    async deleteTraces(envId: string) {
        this.db.prepare("DELETE FROM traces WHERE env_id = ?").run(envId);
    }

    async cacheGet(key: string) {
        const row = this.db.prepare("SELECT value FROM upstream WHERE key = ?").get(key) as
            { value: string } | undefined;
        return row?.value ?? null;
    }

    async cachePut(entries: Array<[string, string]>) {
        const statement = this.db.prepare(
            "INSERT OR REPLACE INTO upstream (key, value, seen) VALUES (?, ?, ?)");
        const now = Date.now();
        for (const [ key, value ] of entries) statement.run(key, value, now);
    }

    async cacheCount() {
        return (this.db.prepare("SELECT COUNT(*) AS c FROM upstream").get() as { c: number }).c;
    }

    async close() {
        this.db.close();
    }
}

// ---- Postgres ---------------------------------------------------------------

const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS traces (
    env_id  TEXT NOT NULL,
    hash    TEXT NOT NULL,
    trace   TEXT NOT NULL,
    diff    TEXT NOT NULL,
    PRIMARY KEY (env_id, hash)
);
CREATE TABLE IF NOT EXISTS environments (
    id           text PRIMARY KEY,
    name         text NOT NULL,
    rpc_url      text NOT NULL,
    chain_id     bigint NOT NULL,
    fork_block   text NOT NULL,
    created_at   bigint NOT NULL,
    updated_at   bigint NOT NULL,
    overlay      text NOT NULL,
    chain        text NOT NULL,
    follows_head boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS environments_updated ON environments (updated_at DESC);
/*
 * Added rather than declared: a deployment already has this table. Existing rows
 * start at 0, which is exactly what a process that has never written one sends,
 * so nothing in flight is disturbed by the column appearing.
 */
ALTER TABLE environments ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS upstream (
    key   text PRIMARY KEY,
    value text NOT NULL,
    seen  bigint NOT NULL
);
`;

const fromPostgres = (row: Record<string, unknown>): SavedRow => ({
    revision: Number(row.revision ?? 0),
    id: String(row.id),
    name: String(row.name),
    rpcUrl: String(row.rpc_url),
    chainId: Number(row.chain_id),
    forkBlock: String(row.fork_block),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    overlay: String(row.overlay),
    chain: String(row.chain),
    followsHead: row.follows_head === true,
});

class PostgresBackend implements Backend {
    private readonly sql: postgres.Sql;

    private constructor(sql: postgres.Sql) {
        this.sql = sql;
    }

    static async open(url: string): Promise<PostgresBackend> {
        // Supabase's pooler on 6543 cannot hold prepared statements between
        // statements; leaving them on fails under exactly the concurrency the
        // pooler exists to handle.
        const pooled = url.includes(":6543") || url.includes("pooler.supabase.com");
        const sql = postgres(url, {
            prepare: !pooled,
            max: pooled ? 4 : 10,
            idle_timeout: 20,
            connect_timeout: 10,
            // `CREATE TABLE IF NOT EXISTS` raises a NOTICE for every table that
            // already exists, which is every start after the first. Printed, it
            // reads like a stack of errors on a healthy boot.
            onnotice: () => {},
        });
        await sql.unsafe(POSTGRES_SCHEMA);
        return new PostgresBackend(sql);
    }

    async loadEnvironment(id: string) {
        const [ row ] = await this.sql`SELECT * FROM environments WHERE id = ${id} LIMIT 1`;
        return row ? fromPostgres(row) : null;
    }

    async saveEnvironment(row: SavedRow) {
        const result = await this.sql`
            INSERT INTO environments
                (id, name, rpc_url, chain_id, fork_block, created_at, updated_at,
                 overlay, chain, follows_head, revision)
            VALUES (${row.id}, ${row.name}, ${row.rpcUrl}, ${row.chainId}, ${row.forkBlock},
                    ${row.createdAt}, ${row.updatedAt}, ${row.overlay}, ${row.chain},
                    ${row.followsHead}, ${row.revision + 1})
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name, updated_at = EXCLUDED.updated_at,
                overlay = EXCLUDED.overlay, chain = EXCLUDED.chain,
                fork_block = EXCLUDED.fork_block, follows_head = EXCLUDED.follows_head,
                revision = EXCLUDED.revision
            WHERE environments.revision = ${row.revision}`;
        return result.count > 0;
    }

    async listEnvironments() {
        const rows = await this.sql`SELECT * FROM environments ORDER BY updated_at DESC`;
        return rows.map(fromPostgres);
    }

    async deleteEnvironment(id: string) {
        return (await this.sql`DELETE FROM environments WHERE id = ${id}`).count > 0;
    }

    async saveTrace(envId: string, hash: string, trace: string, diff: string) {
        await this.sql`
            INSERT INTO traces (env_id, hash, trace, diff)
            VALUES (${envId}, ${hash}, ${trace}, ${diff})
            ON CONFLICT (env_id, hash) DO UPDATE SET
                trace = EXCLUDED.trace, diff = EXCLUDED.diff`;
    }

    async loadTrace(envId: string, hash: string) {
        const [ row ] = await this.sql`
            SELECT trace, diff FROM traces WHERE env_id = ${envId} AND hash = ${hash} LIMIT 1`;
        return row ? { trace: String(row.trace), diff: String(row.diff) } : null;
    }

    async deleteTraces(envId: string) {
        await this.sql`DELETE FROM traces WHERE env_id = ${envId}`;
    }

    async cacheGet(key: string) {
        const [ row ] = await this.sql`SELECT value FROM upstream WHERE key = ${key} LIMIT 1`;
        return row ? String(row.value) : null;
    }

    async cachePut(entries: Array<[string, string]>) {
        if (entries.length === 0) return;
        const now = Date.now();
        const rows = entries.map(([ key, value ]) => ({ key, value, seen: now }));
        // One statement for the whole batch: a cold call misses dozens of keys,
        // and a round trip each would cost more than the reads it is saving.
        await this.sql`
            INSERT INTO upstream ${this.sql(rows, "key", "value", "seen")}
            ON CONFLICT (key) DO NOTHING`;
    }

    async cacheCount() {
        const [ row ] = await this.sql`SELECT count(*)::int AS n FROM upstream`;
        return Number(row!.n);
    }

    async close() {
        await this.sql.end();
    }
}

/**
 * Picks a backend.
 *
 * `DATABASE_URL` wins when it is set, because a deployment that has one has
 * chosen not to depend on a disk.
 */
export async function openBackend(options: { url?: string; path?: string }): Promise<Backend> {
    if (options.url) return await PostgresBackend.open(options.url);
    if (options.path) return await SqliteBackend.open(options.path);
    throw new Error("A backend needs either a Postgres URL or a file path.");
}
