/**
 * One row per environment.
 *
 * An overlay is small — a few hundred bytes for a fork that has patched a
 * balance — so it is stored whole rather than as a table of writes. What that
 * buys is that restoring an environment is one read and no assembly.
 */
import type { Backend, SavedRow, UsageRow } from "./backend.ts";
import type { Overlay } from "./overlay.ts";
import type { Chain } from "./chain.ts";

export interface SavedEnvironment {
    id: string;
    name: string;
    rpcUrl: string;
    chainId: number;
    forkBlock: string;
    createdAt: number;
    updatedAt: number;
    overlay: Overlay;
    chain: ReturnType<Chain["export"]>;
    /** The row version this is replacing; 0 for one that has never been written. */
    revision: number;
    followsHead: boolean;
}

export interface EnvironmentSummary {
    id: string;
    name: string;
    chainId: number;
    forkBlock: string;
    blocks: number;
    bytes: number;
    createdAt: number;
    updatedAt: number;
    followsHead: boolean;
}

const parse = (row: SavedRow): SavedEnvironment => ({
    revision: row.revision,
    id: row.id,
    name: row.name,
    rpcUrl: row.rpcUrl,
    chainId: row.chainId,
    forkBlock: row.forkBlock,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    overlay: JSON.parse(row.overlay) as Overlay,
    chain: JSON.parse(row.chain) as ReturnType<Chain["export"]>,
    followsHead: row.followsHead,
});

export class Store {
    private readonly backend: Backend;

    constructor(backend: Backend) {
        this.backend = backend;
    }

    /**
     * Writes an environment out, unless someone else has written it since.
     *
     * Returns false in that case rather than throwing: whether a losing write is
     * an error depends on what the caller was doing, and only the caller knows.
     */
    async save(env: SavedEnvironment): Promise<boolean> {
        return this.backend.saveEnvironment({
            id: env.id,
            name: env.name,
            rpcUrl: env.rpcUrl,
            chainId: env.chainId,
            forkBlock: env.forkBlock,
            createdAt: env.createdAt,
            updatedAt: env.updatedAt,
            overlay: JSON.stringify(env.overlay),
            chain: JSON.stringify(env.chain),
            followsHead: env.followsHead,
            revision: env.revision,
        });
    }

    async load(id: string): Promise<SavedEnvironment | null> {
        const row = await this.backend.loadEnvironment(id);
        return row ? parse(row) : null;
    }

    async list(): Promise<EnvironmentSummary[]> {
        return (await this.backend.listEnvironments()).map((row) => {
            const chain = JSON.parse(row.chain) as ReturnType<Chain["export"]>;
            return {
                id: row.id,
                name: row.name,
                chainId: row.chainId,
                forkBlock: row.forkBlock,
                blocks: chain.blocks.length,
                bytes: row.overlay.length,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                followsHead: row.followsHead,
            };
        });
    }

    /** Running totals per environment per day. Written in batches, never per read. */
    async addUsage(entries: UsageRow[]): Promise<void> {
        await this.backend.addUsage(entries);
    }

    async readUsage(envId: string, since: string): Promise<Array<Omit<UsageRow, "envId">>> {
        return this.backend.readUsage(envId, since);
    }

    /** A transaction's trace and diff, kept for as long as the environment is. */
    async saveTrace(envId: string, hash: string, trace: string, diff: string): Promise<void> {
        await this.backend.saveTrace(envId, hash, trace, diff);
    }

    async loadTrace(envId: string, hash: string): Promise<{ trace: string; diff: string } | null> {
        return this.backend.loadTrace(envId, hash);
    }

    async suspend(envId: string, reason: string) {
        return this.backend.suspend(envId, reason);
    }

    async unsuspend(envId: string) {
        return this.backend.unsuspend(envId);
    }

    async suspension(envId: string) {
        return this.backend.suspension(envId);
    }

    async listAlerts(envId: string) {
        return this.backend.listAlerts(envId);
    }

    async deleteAlerts(envId: string): Promise<void> {
        await this.backend.deleteAlerts(envId);
    }

    async deleteTraces(envId: string): Promise<void> {
        await this.backend.deleteTraces(envId);
    }

    async delete(id: string): Promise<boolean> {
        return await this.backend.deleteEnvironment(id);
    }
}
