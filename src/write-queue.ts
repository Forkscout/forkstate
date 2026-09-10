/*
 * One write at a time, per environment.
 *
 * Two writes on one process share the in-memory environment, so their blocks are
 * mixed together before either is written out: whichever persists first carries
 * the other's block with it, and the other is then told its work was rejected
 * when it is in fact on the chain. Observed exactly once in fifty against two
 * replicas.
 *
 * Its own module because there are now two ways in — HTTP and a socket — and a
 * queue that only one of them uses is not a queue.
 */

/**
 * Methods that change something, and so must not run beside another.
 *
 * `forkstate_simulateBundle` is here despite changing nothing: it runs inside a
 * checkpoint it always reverts, but holds that checkpoint open across many
 * transactions, and a real transaction landing in the middle would be committed
 * into it and thrown away with it. Persisting is a no-op for it either way,
 * since nothing it does moves the environment's version.
 */
export const MUTATES =
    /^(eth_sendTransaction|eth_sendRawTransaction|anvil_|evm_|forkstate_(setChainId|setTokenBalance|sync|followHead|simulateBundle))/;

export const mutating = (payload: unknown): boolean => {
    const one = (call: unknown) => MUTATES.test(String((call as { method?: unknown })?.method ?? ""));
    return Array.isArray(payload) ? payload.some(one) : one(payload);
};

export class WriteQueue {
    private readonly writing = new Map<string, Promise<unknown>>();

    /** Runs `work` once everything already queued for this environment has finished. */
    run<T>(id: string, work: () => Promise<T>): Promise<T> {
        const queued = (this.writing.get(id) ?? Promise.resolve()).then(work, work);
        // The chain, not the result: a failed write must not stop the next one.
        const tail = queued.then(() => {}, () => {});
        this.writing.set(id, tail);
        // Dropped once nothing is behind it, so an idle environment leaves
        // nothing in the map.
        void tail.then(() => {
            if (this.writing.get(id) === tail) this.writing.delete(id);
        });
        return queued;
    }
}
