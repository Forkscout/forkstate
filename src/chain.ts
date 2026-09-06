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

    constructor(forkHeight: number) {
        this.forkHeightValue = forkHeight;
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
        }
    }

    export(): { forkHeight: number; blocks: StoredBlock[]; txs: StoredTx[] } {
        return { forkHeight: this.forkHeightValue, blocks: this.blocks, txs: [ ...this.txs.values() ] };
    }

    static restore(data: { forkHeight: number; blocks: StoredBlock[]; txs: StoredTx[] }): Chain {
        const chain = new Chain(data.forkHeight);
        for (const block of data.blocks) {
            chain.blocks.push(block);
            chain.byHash.set(block.hash.toLowerCase(), block);
            chain.byNumber.set(block.number, block);
        }
        for (const tx of data.txs) chain.txs.set(tx.hash.toLowerCase(), tx);
        return chain;
    }
}
