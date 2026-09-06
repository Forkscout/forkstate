/*
 * One compile, in a process of its own.
 *
 * solc's JavaScript build is synchronous and can hold the CPU for seconds on a
 * real project. The engine answers RPC for every environment it holds from one
 * event loop, so compiling in it would stall unrelated forks — and a compiler
 * that runs out of memory would take the node down with it.
 *
 * Plain JavaScript rather than TypeScript so both runtimes can run it with no
 * flags: the parent spawns whichever one it is itself running under.
 *
 * Reads {soljson, input} as JSON on stdin, writes the compiler's output on
 * stdout. Nothing else is printed, because stdout is the protocol.
 */
import { createRequire } from "node:module";
import wrapper from "solc/wrapper.js";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

try {
    const { soljson, input } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const solc = wrapper(createRequire(import.meta.url)(soljson));
    process.stdout.write(solc.compile(input));
} catch (error) {
    process.stdout.write(JSON.stringify({
        errors: [ {
            severity: "error",
            formattedMessage: error instanceof Error ? error.message : String(error),
        } ],
    }));
    process.exitCode = 1;
}
