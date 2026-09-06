/**
 * What this environment has written.
 *
 * The whole point of the design is that this is the *only* thing an environment
 * owns. Mainnet's state is read through to the upstream node and never copied,
 * so an environment nobody has touched is an empty object rather than a chain in
 * memory or a state file on disk.
 */
import { bytesToHex, hexToBytes } from "@ethereumjs/util";

export interface AccountOverlay {
    balance?: string;
    nonce?: string;
    /** Runtime bytecode, `0x` to clear it. */
    code?: string;
    storage?: Record<string, string>;
}

export interface Overlay {
    /** Which chain and height the reads fall through to. Restoring onto a different one is meaningless. */
    chainId: number;
    forkBlock: string;
    /** Blocks this environment has mined on top of the fork. */
    blockNumber: number;
    accounts: Record<string, AccountOverlay>;
}

export function emptyOverlay(chainId: number, forkBlock: bigint): Overlay {
    return { chainId, forkBlock: "0x" + forkBlock.toString(16), accounts: {}, blockNumber: 0 };
}

/** Storage keys and values are 32 bytes; anything shorter is the same number written short. */
export function normaliseWord(value: string): string {
    return "0x" + value.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

export function normaliseAddress(value: string): string {
    return "0x" + value.replace(/^0x/, "").toLowerCase().padStart(40, "0");
}

export function toBytes(hex: string): Uint8Array {
    return hexToBytes(hex as `0x${string}`);
}

export function fromBytes(bytes: Uint8Array): string {
    return bytesToHex(bytes);
}

/** Rough byte cost, for reporting what an environment actually costs to keep. */
export function overlaySize(overlay: Overlay): { accounts: number; slots: number; bytes: number } {
    let slots = 0;
    for (const account of Object.values(overlay.accounts)) {
        slots += Object.keys(account.storage ?? {}).length;
    }
    return {
        accounts: Object.keys(overlay.accounts).length,
        slots,
        bytes: Buffer.byteLength(JSON.stringify(overlay)),
    };
}
