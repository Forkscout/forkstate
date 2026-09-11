/**
 * The blocks this environment has produced.
 *
 * Only what happened here is stored. The parent chain's history is not copied and
 * not served: a block below the fork height belongs to the parent, and asking this
 * for it is a question about a different chain.
 */
import type { Log } from "./types.ts";

export interface StoredTx {
    hash: string;
    blockNumber: number;
    /** Set when the block is mined, so a receipt can name the block it is in. */
    blockHash?: string;
    transactionIndex: number;
    from: string;
    to: string | null;
    value: string;
    input: string;
    nonce: number;
    gas: string;
    gasPrice: string;
    gasUsed: string;
    status: 0 | 1;
    contractAddress: string | null;
    logs: Log[];
    /** Set when the transaction reverted, with the reason if the contract gave one. */
    error: string | null;
    /**
     * The bytes the revert returned, kept raw.
     *
     * A custom error — which is most of them since Solidity 0.8.4 — is four
     * selector bytes and its arguments, and nothing here can name it: that needs
     * the ABI, which the explorer has and the engine does not. Decoding to a
     * string would throw the arguments away, so the bytes travel too.
     */
    revertData?: string | null;
}

/**
 * What one block changed, as the values the overlay held before it.
 *
 * Keyed `address/balance`, `address/nonce`, `address/code` or `address/slot`.
 * Null means the overlay did not hold that value yet — the parent's showed
 * through — so going back past this block means reading the parent again.
 *
 * Before-values rather than after-values because the question is always "what
 * was it then": start from the overlay as it is, undo block by block from the
 * newest, and what is left is the state at the block asked about.
 */
export type Journal = Record<string, string | null>;

/**
 * How many blocks of state are kept.
 *
 * A full Ethereum node keeps 128; an archive node keeps everything and costs
 * terabytes. A fork's journal is only what it changed, so it can afford more
 * than a full node — but every block's journal is written with the
 * environment, so it cannot be unbounded either.
 */
export const HISTORY_BLOCKS = 1024;

export interface History {
    /** The oldest block whose state can be rebuilt. */
    from: number;
    /** Changes since the last block, which the next block will own. */
    pending: Journal;
    blocks: Record<string, Journal>;
}

export interface StoredBlock {
    number: number;
    hash: string;
    parentHash: string;
    timestamp: number;
    gasUsed: string;
    gasLimit: string;
    baseFeePerGas: string;
    miner: string;
    transactions: string[];
}

export class Chain {
    private readonly blocks: StoredBlock[] = [];
    private readonly byHash = new Map<string, StoredBlock>();
    private readonly byNumber = new Map<number, StoredBlock>();
    private readonly txs = new Map<string, StoredTx>();

    /**
     * The height the parent chain was at when this environment last took its state.
     *
     * It moves when the fork follows the parent's head, which is why blocks are
     * indexed by their own number rather than by an offset from it: an offset
     * would silently repoint every block already produced.
     */
    private forkHeightValue: number;

    private journals = new Map<number, Journal>();
    private pending: Journal = {};
    private historyFromValue: number;

    constructor(forkHeight: number) {
        this.forkHeightValue = forkHeight;
        this.historyFromValue = forkHeight;
    }

    /** The oldest block the state of which can still be rebuilt. */
    get historyFrom(): number {
        return this.historyFromValue;
    }

    /**
     * Records what a value was before this block first changed it.
     *
     * Only the first change in a block counts: that is the value the block
     * started from, and later writes in the same block are its own business.
     */
    note(key: string, before: string | null): void {
        if (!(key in this.pending)) this.pending[key] = before;
    }

    /** Every journal after `number`, newest first — the order to undo them in. */
    journalsAfter(number: number): Journal[] {
        const out = [ this.pending ];
        for (let n = this.height; n > number; n--) {
            const journal = this.journals.get(n);
            if (journal) out.push(journal);
        }
        return out;
    }

    /** The chain as it stood at `number`, for rebuilding an environment there. */
    exportUpTo(number: number): ReturnType<Chain["export"]> {
        const blocks = this.blocks.filter((block) => block.number <= number);
        const kept = new Set(blocks.flatMap((block) => block.transactions.map((hash) => hash.toLowerCase())));
        return {
            forkHeight: this.forkHeightValue,
            blocks,
            txs: [ ...this.txs.values() ].filter((tx) => kept.has(tx.hash.toLowerCase())),
            history: { from: number, pending: {}, blocks: {} },
        };
    }

    /** Puts back the history a snapshot held, as evm_revert does with everything else. */
    resetHistory(history?: History): void {
        this.pending = { ...(history?.pending ?? {}) };
        this.journals = new Map(Object.entries(history?.blocks ?? {}).map(([ n, j ]) => [ Number(n), { ...j } ]));
        this.historyFromValue = history?.from ?? this.height;
    }

    get forkHeight(): number {
        return this.forkHeightValue;
    }

    /** Blocks produced here; the parent's are not counted. */
    get length(): number {
        return this.blocks.length;
    }

    /**
     * Height as a wallet sees it.
     *
     * The fork point counts even when it is above the last block produced here,
     * which is exactly what happens after following the head: reporting the older
     * local block would leave a chain whose height sits below the state it is
     * serving, and whose next block would be numbered under one already mined.
     */
    get height(): number {
        return Math.max(this.blocks[this.blocks.length - 1]?.number ?? 0, this.forkHeightValue);
    }

    /**
     * Moves the fork point up to a newer parent block.
     *
     * Refused if it would put the fork point at or below a block we have already
     * produced: a chain whose height goes backwards hands out two different
     * blocks under one number, and every receipt already issued starts lying.
     */
    advanceForkTo(height: number): boolean {
        if (height <= this.height) return false;
        this.forkHeightValue = height;
        // The journals undo writes made against the old fork block. Below the
        // new one the parent answers, so they have nothing left to undo.
        this.journals.clear();
        this.pending = {};
        this.historyFromValue = height;
        return true;
    }

    latest(): StoredBlock | null {
        return this.blocks[this.blocks.length - 1] ?? null;
    }

    getBlock(numberOrHash: number | string): StoredBlock | null {
        if (typeof numberOrHash === "string") return this.byHash.get(numberOrHash.toLowerCase()) ?? null;
        return this.byNumber.get(numberOrHash) ?? null;
    }

    getTx(hash: string): StoredTx | null {
        return this.txs.get(hash.toLowerCase()) ?? null;
    }

    /** Most recent first, which is the order anything reading a chain wants. */
    recentTxs(limit: number): StoredTx[] {
        return [ ...this.txs.values() ].reverse().slice(0, limit);
    }

    add(block: StoredBlock, transactions: StoredTx[]): void {
        this.blocks.push(block);
        this.byHash.set(block.hash.toLowerCase(), block);
        this.byNumber.set(block.number, block);
        for (const tx of transactions) this.txs.set(tx.hash.toLowerCase(), tx);

        this.journals.set(block.number, this.pending);
        this.pending = {};
        // Oldest first, because blocks are only ever added at the top.
        while (this.journals.size > HISTORY_BLOCKS) {
            const oldest = this.journals.keys().next().value as number;
            this.journals.delete(oldest);
            // Without that block's journal, the state before it cannot be rebuilt.
            this.historyFromValue = Math.max(this.historyFromValue, oldest);
        }
    }

    /**
     * Drops every block above `height`, as a revert does.
     *
     * Transactions go with them: leaving a receipt behind for a block that no
     * longer exists is worse than losing it, because it answers as if it happened.
     */
    rollbackTo(height: number): void {
        while (this.blocks.length > 0 && this.height > height) {
            const block = this.blocks.pop()!;
            this.byHash.delete(block.hash.toLowerCase());
            this.byNumber.delete(block.number);
            for (const hash of block.transactions) this.txs.delete(hash.toLowerCase());
            this.journals.delete(block.number);
        }
    }

    export(): { forkHeight: number; blocks: StoredBlock[]; txs: StoredTx[]; history?: History } {
        return {
            forkHeight: this.forkHeightValue,
            blocks: this.blocks,
            txs: [ ...this.txs.values() ],
            history: {
                from: this.historyFromValue,
                pending: this.pending,
                blocks: Object.fromEntries(this.journals),
            },
        };
    }

    static restore(data: { forkHeight: number; blocks: StoredBlock[]; txs: StoredTx[]; history?: History }): Chain {
        const chain = new Chain(data.forkHeight);
        for (const block of data.blocks) {
            chain.blocks.push(block);
            chain.byHash.set(block.hash.toLowerCase(), block);
            chain.byNumber.set(block.number, block);
        }
        for (const tx of data.txs) chain.txs.set(tx.hash.toLowerCase(), tx);
        // A row written before history was kept has none: its past blocks stay
        // unanswerable, and everything mined from now on is recorded.
        chain.resetHistory(data.history);
        return chain;
    }
}
