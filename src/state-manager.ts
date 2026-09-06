/**
 * A state manager that can fork at any depth, and shares what it reads.
 *
 * Three things separate it from the library's `RPCStateManager`.
 *
 * **It does not use `eth_getProof`.** A provider serves proofs only while it
 * still holds the trie — measured on BNB Chain, about a hundred blocks, which at
 * a 0.16 second block time is under a minute. Past that it fails with "missing
 * trie node", so a fork pinned any further back cannot be restored. Plain reads
 * have no such limit: `eth_getBalance`, `eth_getCode`, `eth_getTransactionCount`
 * and `eth_getStorageAt` all answered correctly ten million blocks back on the
 * same free tier. The proof is not missed — it exists to verify a remote answer,
 * and a devnet that already trusts its parent RPC has nothing to check it against.
 *
 * **Every read goes through a cache shared by all environments.** The parent
 * chain's state at a block is the same for everyone, so a hundred forks of the
 * same contract fetch its code once.
 *
 * **Filling a slot from the parent is not a write.** The base class writes what
 * it fetched back through `putStorage`, which is indistinguishable from a
 * contract storing something — and an overlay that records reads grows for no
 * reason and stops tracking the parent for values it never changed.
 */
import { RPCStateManager } from "@ethereumjs/statemanager";
import { bytesToHex, createAccount, hexToBytes, type Account, type Address } from "@ethereumjs/util";
import { UpstreamCache } from "./upstream-cache.ts";

export interface ForkStateOptions {
    provider: string;
    blockTag: bigint;
    cache?: UpstreamCache | null;
}

export class ForkStateManager extends RPCStateManager {
    private readonly url: string;
    private readonly tag: string;
    private readonly shared: UpstreamCache | null;
    /** Identifies the parent chain in cache keys without putting an API key in one. */
    private readonly chainKey: string;
    /** Set while a value fetched from the parent is being stored, so it is not recorded as a write. */
    filling = false;

    constructor(options: ForkStateOptions) {
        super({ provider: options.provider, blockTag: options.blockTag });
        this.url = options.provider;
        this.tag = "0x" + options.blockTag.toString(16);
        this.shared = options.cache ?? null;
        this.chainKey = new URL(options.provider).host;
    }

    private async rpc<T>(method: string, params: unknown[]): Promise<T> {
        const res = await fetch(this.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        const body = await res.json() as { result?: T; error?: { message: string } };
        if (body.error) throw new Error(`${method}: ${body.error.message}`);
        return body.result as T;
    }

    /** A parent read, answered from the shared cache when anyone has asked it before. */
    private async cached(kind: string, address: string, slot: string | undefined, fetchIt: () => Promise<string>): Promise<string> {
        if (!this.shared) return fetchIt();
        const key = UpstreamCache.key(this.chainKey, this.tag, kind, address, slot);
        const hit = await this.shared.get(key);
        if (hit !== null) return hit;
        const value = await fetchIt();
        this.shared.set(key, value);
        return value;
    }

    override async getAccountFromProvider(address: Address): Promise<Account> {
        const who = address.toString();
        const [ balance, nonce ] = await Promise.all([
            this.cached("balance", who, undefined, () =>
                this.rpc<string>("eth_getBalance", [ who, this.tag ]).then((v) => v ?? "0x0")),
            this.cached("nonce", who, undefined, () =>
                this.rpc<string>("eth_getTransactionCount", [ who, this.tag ]).then((v) => v ?? "0x0")),
        ]);

        // The code hash and storage root stay at their empty values: nothing here
        // walks the trie, because code and storage are fetched by their own methods.
        return createAccount({ balance: BigInt(balance), nonce: BigInt(nonce) });
    }

    override async getCode(address: Address): Promise<Uint8Array> {
        const local = this["_caches"]?.code?.get(address)?.code;
        if (local !== undefined) return local;

        const code = await this.cached("code", address.toString(), undefined, () =>
            this.rpc<string>("eth_getCode", [ address.toString(), this.tag ]).then((v) => v ?? "0x"));
        const bytes = hexToBytes(code as `0x${string}`);
        this["_caches"]?.code?.put(address, bytes);
        return bytes;
    }

    /**
     * Commits every cache, not only the account one.
     *
     * `RPCStateManager.commit()` calls `this._caches.account?.commit()` and stops
     * there, while `checkpoint()` and `revert()` act on account, storage and code
     * alike. So each committed EVM frame leaves the storage and code caches one
     * layer deeper than the account cache, and the layers drift apart.
     *
     * What that looks like from outside is an `eth_call` changing state: run a
     * swap through a Pancake pair and its reentrancy slot comes back set, so the
     * next swap — simulated or real — fails with "Pancake: LOCKED". Two identical
     * calls giving different answers is about as wrong as a fork can be.
     */
    override async commit(): Promise<void> {
        this["_caches"]?.commit();
    }

    override async getStorage(address: Address, key: Uint8Array): Promise<Uint8Array> {
        if (key.length !== 32) throw new Error("Storage key must be 32 bytes long");

        const local = this["_caches"]?.storage?.get(address, key);
        if (local !== undefined) return local;

        const slot = bytesToHex(key);
        const value = await this.cached("slot", address.toString(), slot, () =>
            this.rpc<string>("eth_getStorageAt", [ address.toString(), slot, this.tag ]).then((v) => v ?? "0x0"));

        const bytes = hexToBytes(value as `0x${string}`);
        // Marked as a fill so the overlay does not mistake the parent's value for
        // something this environment decided.
        this.filling = true;
        try {
            await this.putStorage(address, key, bytes);
        } finally {
            this.filling = false;
        }
        return bytes;
    }
}
