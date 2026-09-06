/**
 * One SQLite interface over two runtimes.
 *
 * Node ships `node:sqlite`; Bun ships `bun:sqlite` and, as of 1.3, not the other
 * one. The two APIs are near enough that a shim is thirty lines, which is a
 * cheap price for an image that is half the size — a Bun binary is 70 MB against
 * Node's 121 MB, and nothing here needs a package manager at runtime.
 *
 * The specifier is built at runtime on purpose: written as a literal, Node's
 * loader tries to resolve "bun:sqlite" while parsing this file and fails before
 * the branch that skips it ever runs.
 */
export interface Statement {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Array<Record<string, unknown>>;
}

export interface Database {
    exec(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

type BunStatement = {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | null;
    all(...params: unknown[]): Array<Record<string, unknown>>;
};

export async function openDatabase(path: string): Promise<Database> {
    const specifier = isBun ? "bun:sqlite" : "node:sqlite";
    const module = await import(/* webpackIgnore: true */ specifier) as Record<string, unknown>;

    if (isBun) {
        const Ctor = module.Database as new (path: string) => {
            exec(sql: string): void;
            prepare(sql: string): BunStatement;
            close(): void;
        };
        const db = new Ctor(path);
        return {
            exec: (sql) => db.exec(sql),
            close: () => db.close(),
            prepare: (sql) => {
                const statement = db.prepare(sql);
                return {
                    run: (...params) => statement.run(...params),
                    // Bun returns null for no row where Node returns undefined,
                    // and callers here test with `??`.
                    get: (...params) => statement.get(...params) ?? undefined,
                    all: (...params) => statement.all(...params),
                };
            },
        };
    }

    const Ctor = module.DatabaseSync as new (path: string) => Database;
    return new Ctor(path);
}
