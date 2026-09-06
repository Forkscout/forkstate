export interface Log {
    address: string;
    topics: string[];
    data: string;
    blockNumber: string;
    transactionHash: string;
    transactionIndex: string;
    blockHash: string;
    logIndex: string;
    removed: boolean;
}

export interface TransactionRequest {
    from?: string;
    to?: string;
    data?: string;
    input?: string;
    value?: string;
    gas?: string;
    gasPrice?: string;
    nonce?: string;
}
