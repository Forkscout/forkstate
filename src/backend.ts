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

/** One environment's totals for one day. */
export interface UsageRow {
    envId: string;
    day: string;
    requests: number;
    misses: number;
    forwarded: number;
}

/** A rule someone set on an environment, and where to tell them about it. */
export interface AlertRow {
    id: string;
    envId: string;
    name: string;
    url: string;
    /** Signs the body, so the receiver can tell this from anyone who found the URL. */
    secret: string;
    kind: "logs" | "transactions" | "blocks";
    /** JSON, shaped by the kind. */
    criteria: string;
    active: boolean;
    createdAt: number;
    lastFiredAt: number | null;
    /** Consecutive failures. Reset by a success; enough of them turns the alert off. */
    failures: number;
}

/** One attempt to tell somebody, kept so they can see why it did not arrive. */
export interface DeliveryRow {
    id: string;
    alertId: string;
    at: number;
    ok: boolean;
    status: number | null;
    error: string | null;
    matches: number;
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
    /** Adds to each environment's running totals for a day. */
    addUsage(entries: UsageRow[]): Promise<void>;
    readUsage(envId: string, since: string): Promise<Array<Omit<UsageRow, "envId">>>;

    saveTrace(envId: string, hash: string, trace: string, diff: string): Promise<void>;
    loadTrace(envId: string, hash: string): Promise<{ trace: string; diff: string } | null>;
    deleteTraces(envId: string): Promise<void>;

    /**
     * Alerts, and what happened when they last fired.
     *
     * Kept beside the environment rather than inside its row: the row is
     * rewritten on every block, and a rule someone typed once should not be
     * re-serialised a thousand times a day to sit still.
     */
    listAlerts(envId: string): Promise<AlertRow[]>;
    saveAlert(row: AlertRow): Promise<void>;
    deleteAlert(envId: string, id: string): Promise<boolean>;
    deleteAlerts(envId: string): Promise<void>;
    recordDelivery(row: DeliveryRow): Promise<void>;
    listDeliveries(alertId: string, limit: number): Promise<DeliveryRow[]>;

    /**
     * Environments told to stop answering, and why.
     *
     * Separate from the environment row, which is rewritten on every block under
     * a revision check: a suspension landing between two writes would either be
     * lost or make the next honest write fail as stale.
     */
    suspend(envId: string, reason: string): Promise<void>;
    unsuspend(envId: string): Promise<boolean>;
    suspension(envId: string): Promise<{ reason: string; at: number } | null>;

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
CREATE TABLE IF NOT EXISTS usage (
    env_id    TEXT NOT NULL,
    day       TEXT NOT NULL,
    requests  INTEGER NOT NULL DEFAULT 0,
    misses    INTEGER NOT NULL DEFAULT 0,
    forwarded INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (env_id, day)
);
CREATE TABLE IF NOT EXISTS alerts (
    id           TEXT PRIMARY KEY,
    env_id       TEXT NOT NULL,
    name         TEXT NOT NULL,
    url          TEXT NOT NULL,
    secret       TEXT NOT NULL,
    kind         TEXT NOT NULL,
    criteria     TEXT NOT NULL,
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL,
    last_fired_at INTEGER,
    failures     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS alerts_env ON alerts (env_id);
CREATE TABLE IF NOT EXISTS alert_deliveries (
    id       TEXT PRIMARY KEY,
    alert_id TEXT NOT NULL,
    at       INTEGER NOT NULL,
    ok       INTEGER NOT NULL,
    status   INTEGER,
    error    TEXT,
    matches  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS alert_deliveries_alert ON alert_deliveries (alert_id, at DESC);
CREATE TABLE IF NOT EXISTS suspensions (
    env_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    at     INTEGER NOT NULL
);
`;

const toAlert = (row: Record<string, unknown>): AlertRow => ({
    id: String(row.id),
    envId: String(row.env_id),
    name: String(row.name),
    url: String(row.url),
    secret: String(row.secret),
    kind: String(row.kind) as AlertRow["kind"],
    criteria: String(row.criteria),
    active: row.active === true || Number(row.active) === 1,
    createdAt: Number(row.created_at),
    lastFiredAt: row.last_fired_at === null || row.last_fired_at === undefined
        ? null : Number(row.last_fired_at),
    failures: Number(row.failures ?? 0),
});

const toDelivery = (row: Record<string, unknown>): DeliveryRow => ({
    id: String(row.id),
    alertId: String(row.alert_id),
    at: Number(row.at),
    ok: row.ok === true || Number(row.ok) === 1,
    status: row.status === null || row.status === undefined ? null : Number(row.status),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    matches: Number(row.matches ?? 0),
});

/** Deliveries older than this many, per alert, are dropped as new ones arrive. */
const DELIVERIES_KEPT = 20;

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
        const usageColumns = new Set((db.prepare("PRAGMA table_info(usage)").all() as
            Array<{ name: string }>).map((c) => c.name));
        if (!usageColumns.has("forwarded")) {
            db.exec("ALTER TABLE usage ADD COLUMN forwarded INTEGER NOT NULL DEFAULT 0");
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

    async addUsage(entries: UsageRow[]) {
        const statement = this.db.prepare(`
            INSERT INTO usage (env_id, day, requests, misses, forwarded) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(env_id, day) DO UPDATE SET
                requests  = usage.requests  + excluded.requests,
                misses    = usage.misses    + excluded.misses,
                forwarded = usage.forwarded + excluded.forwarded`);
        for (const e of entries) statement.run(e.envId, e.day, e.requests, e.misses, e.forwarded);
    }

    async readUsage(envId: string, since: string) {
        return this.db.prepare(`
            SELECT day, requests, misses, forwarded FROM usage
            WHERE env_id = ? AND day >= ? ORDER BY day`)
            .all(envId, since) as Array<Omit<UsageRow, "envId">>;
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

    async listAlerts(envId: string) {
        return (this.db.prepare(
            "SELECT * FROM alerts WHERE env_id = ? ORDER BY created_at DESC").all(envId) as
            Array<Record<string, unknown>>).map(toAlert);
    }

    async saveAlert(row: AlertRow) {
        this.db.prepare(`
            INSERT INTO alerts
                (id, env_id, name, url, secret, kind, criteria, active, created_at,
                 last_fired_at, failures)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name, url = excluded.url, kind = excluded.kind,
                criteria = excluded.criteria, active = excluded.active,
                last_fired_at = excluded.last_fired_at, failures = excluded.failures`)
            .run(row.id, row.envId, row.name, row.url, row.secret, row.kind, row.criteria,
                row.active ? 1 : 0, row.createdAt, row.lastFiredAt, row.failures);
    }

    async deleteAlert(envId: string, id: string) {
        const gone = this.db.prepare("DELETE FROM alerts WHERE env_id = ? AND id = ?")
            .run(envId, id);
        this.db.prepare("DELETE FROM alert_deliveries WHERE alert_id = ?").run(id);
        return Number(gone.changes) > 0;
    }

    async deleteAlerts(envId: string) {
        this.db.prepare(
            "DELETE FROM alert_deliveries WHERE alert_id IN (SELECT id FROM alerts WHERE env_id = ?)")
            .run(envId);
        this.db.prepare("DELETE FROM alerts WHERE env_id = ?").run(envId);
    }

    async recordDelivery(row: DeliveryRow) {
        this.db.prepare(`
            INSERT INTO alert_deliveries (id, alert_id, at, ok, status, error, matches)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(row.id, row.alertId, row.at, row.ok ? 1 : 0, row.status, row.error, row.matches);
        // Trimmed here rather than by a sweep: this is the only place rows arrive.
        this.db.prepare(`
            DELETE FROM alert_deliveries WHERE alert_id = ? AND id NOT IN (
                SELECT id FROM alert_deliveries WHERE alert_id = ? ORDER BY at DESC LIMIT ?)`)
            .run(row.alertId, row.alertId, DELIVERIES_KEPT);
    }

    async listDeliveries(alertId: string, limit: number) {
        return (this.db.prepare(
            "SELECT * FROM alert_deliveries WHERE alert_id = ? ORDER BY at DESC LIMIT ?")
            .all(alertId, limit) as Array<Record<string, unknown>>).map(toDelivery);
    }

    async suspend(envId: string, reason: string) {
        this.db.prepare(`
            INSERT INTO suspensions (env_id, reason, at) VALUES (?, ?, ?)
            ON CONFLICT(env_id) DO UPDATE SET reason = excluded.reason, at = excluded.at`)
            .run(envId, reason, Date.now());
    }

    async unsuspend(envId: string) {
        return Number(this.db.prepare("DELETE FROM suspensions WHERE env_id = ?").run(envId).changes) > 0;
    }

    async suspension(envId: string) {
        const row = this.db.prepare("SELECT reason, at FROM suspensions WHERE env_id = ?").get(envId) as
            { reason: string; at: number } | undefined;
        return row ? { reason: String(row.reason), at: Number(row.at) } : null;
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

/** One number every process agrees on, so they queue rather than deadlock. */
const SCHEMA_LOCK = 8_314_206;

/** Bumped whenever POSTGRES_SCHEMA changes, so a later addition is not skipped. */
const SCHEMA_VERSION = 4;

/**
 * Which row of `schema_meta` is the engine's.
 *
 * The console shares this database and has its own schema and its own version
 * number. Both wrote to row 1 and both read the first row they found, so the
 * console's version 5 told the engine it was five migrations ahead of itself and
 * the engine's next table was silently never created. One row each.
 */
const SCHEMA_ROW = 2;

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
CREATE TABLE IF NOT EXISTS schema_meta (
    id      int PRIMARY KEY,
    version int NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
    env_id   text NOT NULL,
    day      text NOT NULL,
    requests bigint NOT NULL DEFAULT 0,
    misses   bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (env_id, day)
);
CREATE TABLE IF NOT EXISTS upstream (
    key   text PRIMARY KEY,
    value text NOT NULL,
    seen  bigint NOT NULL
);
/*
 * Added rather than declared, like revision: a deployment already has this
 * table. Existing days start at 0, which is true — nothing counted them.
 */
ALTER TABLE usage ADD COLUMN IF NOT EXISTS forwarded bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS alerts (
    id            text PRIMARY KEY,
    env_id        text NOT NULL,
    name          text NOT NULL,
    url           text NOT NULL,
    secret        text NOT NULL,
    kind          text NOT NULL,
    criteria      text NOT NULL,
    active        boolean NOT NULL DEFAULT true,
    created_at    bigint NOT NULL,
    last_fired_at bigint,
    failures      int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS alerts_env ON alerts (env_id);
CREATE TABLE IF NOT EXISTS alert_deliveries (
    id       text PRIMARY KEY,
    alert_id text NOT NULL,
    at       bigint NOT NULL,
    ok       boolean NOT NULL,
    status   int,
    error    text,
    matches  int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS alert_deliveries_alert ON alert_deliveries (alert_id, at DESC);
CREATE TABLE IF NOT EXISTS suspensions (
    env_id text PRIMARY KEY,
    reason text NOT NULL,
    at     bigint NOT NULL
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
        /*
         * At most one process runs the DDL at a time.
         *
         * `ALTER TABLE` takes an exclusive lock, and two replicas starting
         * together take them in whatever order they get there — which deadlocks,
         * and the loser dies on boot. The console hit exactly this and it showed
         * up as a share of every request failing.
         *
         * A cheap look first, because after the first start there is nothing to
         * do; the lock is inside a transaction so a pooled connection cannot
         * hand the release to somebody else.
         */
        /*
         * The version, not whichever column happened to be newest.
         *
         * Checking for a column looks equivalent and is not: it is true the
         * moment that column is added and says nothing about anything added
         * afterwards, so the next new table is silently never created. The
         * console had exactly that and it stayed hidden until something read
         * the missing table.
         */
        let current = 0;
        try {
            const [ row ] = await sql`
                SELECT version FROM schema_meta WHERE id = ${SCHEMA_ROW} LIMIT 1`;
            current = Number(row?.version ?? 0);
        } catch {
            // No marker: an empty database, or one from before this existed.
        }
        if (current < SCHEMA_VERSION) {
            await sql.begin(async (tx) => {
                await tx`SELECT pg_advisory_xact_lock(${ SCHEMA_LOCK })`;
                await tx.unsafe(POSTGRES_SCHEMA);
                await tx`
                    INSERT INTO schema_meta (id, version)
                    VALUES (${SCHEMA_ROW}, ${SCHEMA_VERSION})
                    ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version`;
            });
        }
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

    async addUsage(entries: UsageRow[]) {
        if (entries.length === 0) return;
        const rows = entries.map((e) => ({
            env_id: e.envId, day: e.day, requests: e.requests, misses: e.misses,
            forwarded: e.forwarded,
        }));
        // One statement for the batch: the meter exists to stop paying for round
        // trips, so it should not spend one per environment per flush.
        await this.sql`
            INSERT INTO usage ${this.sql(rows, "env_id", "day", "requests", "misses", "forwarded")}
            ON CONFLICT (env_id, day) DO UPDATE SET
                requests  = usage.requests  + EXCLUDED.requests,
                misses    = usage.misses    + EXCLUDED.misses,
                forwarded = usage.forwarded + EXCLUDED.forwarded`;
    }

    async readUsage(envId: string, since: string) {
        const rows = await this.sql`
            SELECT day, requests, misses, forwarded FROM usage
            WHERE env_id = ${envId} AND day >= ${since} ORDER BY day`;
        return rows.map((r) => ({
            day: String(r.day), requests: Number(r.requests), misses: Number(r.misses),
            forwarded: Number(r.forwarded ?? 0),
        }));
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

    async listAlerts(envId: string) {
        const rows = await this.sql`
            SELECT * FROM alerts WHERE env_id = ${envId} ORDER BY created_at DESC`;
        return rows.map(toAlert);
    }

    async saveAlert(row: AlertRow) {
        await this.sql`
            INSERT INTO alerts
                (id, env_id, name, url, secret, kind, criteria, active, created_at,
                 last_fired_at, failures)
            VALUES (${row.id}, ${row.envId}, ${row.name}, ${row.url}, ${row.secret},
                    ${row.kind}, ${row.criteria}, ${row.active}, ${row.createdAt},
                    ${row.lastFiredAt}, ${row.failures})
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name, url = EXCLUDED.url, kind = EXCLUDED.kind,
                criteria = EXCLUDED.criteria, active = EXCLUDED.active,
                last_fired_at = EXCLUDED.last_fired_at, failures = EXCLUDED.failures`;
    }

    async deleteAlert(envId: string, id: string) {
        await this.sql`DELETE FROM alert_deliveries WHERE alert_id = ${id}`;
        const gone = await this.sql`DELETE FROM alerts WHERE env_id = ${envId} AND id = ${id}`;
        return gone.count > 0;
    }

    async deleteAlerts(envId: string) {
        await this.sql`
            DELETE FROM alert_deliveries
            WHERE alert_id IN (SELECT id FROM alerts WHERE env_id = ${envId})`;
        await this.sql`DELETE FROM alerts WHERE env_id = ${envId}`;
    }

    async recordDelivery(row: DeliveryRow) {
        await this.sql`
            INSERT INTO alert_deliveries (id, alert_id, at, ok, status, error, matches)
            VALUES (${row.id}, ${row.alertId}, ${row.at}, ${row.ok}, ${row.status},
                    ${row.error}, ${row.matches})`;
        // Trimmed here rather than by a sweep: this is the only place rows arrive.
        await this.sql`
            DELETE FROM alert_deliveries WHERE alert_id = ${row.alertId} AND id NOT IN (
                SELECT id FROM alert_deliveries WHERE alert_id = ${row.alertId}
                ORDER BY at DESC LIMIT ${DELIVERIES_KEPT})`;
    }

    async listDeliveries(alertId: string, limit: number) {
        const rows = await this.sql`
            SELECT * FROM alert_deliveries WHERE alert_id = ${alertId}
            ORDER BY at DESC LIMIT ${limit}`;
        return rows.map(toDelivery);
    }

    async suspend(envId: string, reason: string) {
        await this.sql`
            INSERT INTO suspensions (env_id, reason, at) VALUES (${envId}, ${reason}, ${Date.now()})
            ON CONFLICT (env_id) DO UPDATE SET reason = EXCLUDED.reason, at = EXCLUDED.at`;
    }

    async unsuspend(envId: string) {
        const gone = await this.sql`DELETE FROM suspensions WHERE env_id = ${envId}`;
        return gone.count > 0;
    }

    async suspension(envId: string) {
        const [ row ] = await this.sql`SELECT reason, at FROM suspensions WHERE env_id = ${envId} LIMIT 1`;
        return row ? { reason: String(row.reason), at: Number(row.at) } : null;
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
