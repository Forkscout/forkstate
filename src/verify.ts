/**
 * Contract verification, the way every Solidity tool already knows how to ask.
 *
 * Verification is not a database flag. It is a claim that can be checked: compile
 * the source someone hands you with the compiler and settings they name, and see
 * whether the result is the code the chain is actually running. Anything else is
 * just a label, and a label is worth nothing on a testnet where anybody can
 * deploy anything.
 *
 * The submit-then-poll shape is Etherscan's, because that is what
 * `forge verify-contract` and `hardhat verify` speak. Copying the protocol is
 * what makes those tools work here without a plugin.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const BINARIES = "https://binaries.soliditylang.org/bin";

export interface VerifyRequest {
    address: string;
    /** Either one file of Solidity, or a full standard JSON input. */
    codeFormat: "solidity-single-file" | "solidity-standard-json-input";
    sourceCode: string;
    /** `src/Token.sol:Token`, or just `Token`. */
    contractName: string;
    /** `v0.8.20+commit.a1b79de6`, or `0.8.20`. */
    compilerVersion: string;
    optimizationUsed?: boolean;
    runs?: number;
    evmVersion?: string;
    /** Only needed by a contract that links one; `Name: 0xaddress`. */
    libraries?: Record<string, string>;
}

export interface VerifiedContract {
    /** Echoed back so a caller polling by guid knows what was verified. */
    address: string;
    name: string;
    abi: string;
    compiler: string;
    /**
     * `exact` means every byte matched, metadata included. `partial` means the
     * runtime code matched but the trailing metadata hash did not — the same
     * program compiled from a differently named or laid out source tree. Both are
     * worth showing; conflating them is not.
     */
    match: "exact" | "partial";
    /** Every file that went into it, so the page can show what was checked. */
    sources: Record<string, string>;
}

export type VerificationState =
    | { status: "pending" }
    | { status: "pass"; result: VerifiedContract }
    | { status: "fail"; message: string };

// ---------------------------------------------------------------------------
// Compilers

interface CompilerList {
    releases: Record<string, string>;
    builds: Array<{ path: string; longVersion: string }>;
}

let list: { at: number; value: CompilerList } | null = null;

/**
 * The list of published compilers.
 *
 * Held for a day: new releases are rare, and asking on every verification makes
 * the whole thing fail whenever soliditylang.org has a bad minute.
 */
async function compilerList(): Promise<CompilerList> {
    if (list && Date.now() - list.at < 24 * 60 * 60 * 1000) return list.value;
    const response = await fetch(`${BINARIES}/list.json`, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Could not fetch the compiler list (${response.status}).`);
    const value = await response.json() as CompilerList;
    list = { at: Date.now(), value };
    return value;
}

/**
 * The published file for a requested version.
 *
 * Resolved through the list rather than by building a filename, because the
 * version arrives from a request and a filename built from a request is a path
 * for reaching files that are none of its business.
 */
async function resolve(version: string): Promise<{ file: string; long: string }> {
    const wanted = version.trim().replace(/^v/, "");
    const { releases, builds } = await compilerList();

    const release = releases[wanted.split("+")[0]!];
    const build = builds.find((entry) => entry.longVersion === wanted)
        // A plain `0.8.20` means that version's release build.
        ?? builds.find((entry) => entry.path === release);
    if (!build) throw new Error(`Unknown compiler version "${version}".`);
    return { file: build.path, long: build.longVersion };
}

/**
 * Downloads a compiler once and keeps it; they are ~10 MB and never change.
 *
 * The path is made absolute here. `require` reads a relative one as a package
 * name, so a cache directory given as `./data/solc` — which is the default —
 * would be looked for in node_modules and never found.
 *
 * Saved as `.cjs`, not under the `.js` name solc publishes it as. These builds
 * are CommonJS and use `__dirname`, but this package is `"type": "module"`, so
 * a `.js` file inside it is read as ESM — `require` included — and the compiler
 * dies on its first line. The extension is the only thing that overrides that.
 */
async function download(file: string, cacheDir: string): Promise<string> {
    const path = resolvePath(cacheDir, file.replace(/\.js$/, "") + ".cjs");
    if (existsSync(path)) return path;

    const response = await fetch(`${BINARIES}/${file}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Could not download ${file} (${response.status}).`);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
    return path;
}

// ---------------------------------------------------------------------------
// Compiling

interface CompiledContract {
    abi: unknown[];
    evm: {
        deployedBytecode: {
            object: string;
            immutableReferences?: Record<string, Array<{ start: number; length: number }>>;
            linkReferences?: Record<string, Record<string, unknown>>;
        };
    };
}

interface CompilerOutput {
    errors?: Array<{ severity: string; formattedMessage?: string; message?: string }>;
    contracts?: Record<string, Record<string, CompiledContract>>;
}

/** What we need out of every compile, merged over whatever the input asked for. */
const NEEDED = [
    "abi",
    "evm.deployedBytecode.object",
    "evm.deployedBytecode.immutableReferences",
    "evm.deployedBytecode.linkReferences",
];

function buildInput(request: VerifyRequest): { input: Record<string, unknown>; sources: Record<string, string> } {
    if (request.codeFormat === "solidity-standard-json-input") {
        let parsed: Record<string, unknown>;
        try {
            // Etherscan's own clients sometimes wrap the JSON in a second pair of
            // braces, the way its API returns it. Accept what it accepts.
            const text = request.sourceCode.trim();
            parsed = JSON.parse(text.startsWith("{{") ? text.slice(1, -1) : text) as Record<string, unknown>;
        } catch {
            throw new Error("The standard JSON input is not valid JSON.");
        }
        const settings = (parsed.settings ?? {}) as Record<string, unknown>;
        parsed.settings = { ...settings, outputSelection: { "*": { "*": NEEDED } } };

        const given = (parsed.sources ?? {}) as Record<string, { content?: string }>;
        const sources: Record<string, string> = {};
        for (const [ path, file ] of Object.entries(given)) {
            if (typeof file?.content !== "string") {
                throw new Error(`"${path}" has no content — URL-only sources cannot be checked here.`);
            }
            sources[path] = file.content;
        }
        if (Object.keys(sources).length === 0) throw new Error("The standard JSON input has no sources.");
        return { input: parsed, sources };
    }

    const path = `${request.contractName.split(":").pop() ?? "Contract"}.sol`;
    const sources = { [path]: request.sourceCode };
    return {
        input: {
            language: "Solidity",
            sources: { [path]: { content: request.sourceCode } },
            settings: {
                optimizer: { enabled: Boolean(request.optimizationUsed), runs: request.runs ?? 200 },
                ...(request.evmVersion && request.evmVersion !== "default"
                    ? { evmVersion: request.evmVersion }
                    : {}),
                ...(request.libraries ? { libraries: { [path]: request.libraries } } : {}),
                outputSelection: { "*": { "*": NEEDED } },
            },
        },
        sources,
    };
}

/** Runs the compiler in its own process; see solc-worker.mjs for why. */
async function compile(soljson: string, input: string): Promise<CompilerOutput> {
    const worker = join(HERE, "solc-worker.mjs");
    // Whichever runtime is running this one. Both take a plain .mjs with no flags.
    const child = spawn(process.execPath, [ worker ], { stdio: [ "pipe", "pipe", "pipe" ] });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.stdin.end(JSON.stringify({ soljson, input }));

    const text = await new Promise<string>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", () => {
            const printed = Buffer.concat(out).toString("utf8");
            if (printed) return resolve(printed);
            reject(new Error(Buffer.concat(err).toString("utf8").trim() || "The compiler produced nothing."));
        });
    });

    try {
        return JSON.parse(text) as CompilerOutput;
    } catch {
        throw new Error("The compiler's output could not be read.");
    }
}

// ---------------------------------------------------------------------------
// Comparing

const strip = (code: string) => code.replace(/^0x/, "").toLowerCase();

/**
 * Blanks the bytes an immutable occupies.
 *
 * `immutable` values are written into the runtime code at construction, so the
 * compiler's output has zeroes exactly where the chain has the constructor's
 * answers. Comparing without masking them fails every contract that has one.
 */
function maskImmutables(code: string, refs: Record<string, Array<{ start: number; length: number }>>): string {
    const bytes = Buffer.from(code, "hex");
    for (const spans of Object.values(refs)) {
        for (const span of spans) bytes.fill(0, span.start, span.start + span.length);
    }
    return bytes.toString("hex");
}

/**
 * Removes the CBOR metadata solc appends.
 *
 * Its last two bytes are the blob's own length. The blob holds a hash of the
 * source *including its file paths*, so the same program compiled from a
 * different directory layout differs here and nowhere else — which is exactly
 * the difference between an exact and a partial match.
 */
function withoutMetadata(code: string): string {
    if (code.length < 4) return code;
    const length = parseInt(code.slice(-4), 16);
    const trailer = (length + 2) * 2;
    return trailer < code.length ? code.slice(0, code.length - trailer) : code;
}

function compare(
    compiled: string, onchain: string,
    refs: Record<string, Array<{ start: number; length: number }>>,
): "exact" | "partial" | null {
    if (compiled.length !== onchain.length) return null;

    const a = maskImmutables(compiled, refs);
    const b = maskImmutables(onchain, refs);
    if (a === b) return "exact";
    return withoutMetadata(a) === withoutMetadata(b) ? "partial" : null;
}

// ---------------------------------------------------------------------------
// The check itself

/**
 * Compiles what was submitted and compares it with what the chain is running.
 *
 * The runtime code is what gets compared, not the creation code, so constructor
 * arguments do not come into it — which is why they are accepted and ignored
 * rather than demanded.
 */
export async function verifyContract(
    request: VerifyRequest, deployedCode: string, cacheDir: string,
): Promise<VerifiedContract> {
    const onchain = strip(deployedCode);
    if (!onchain || onchain === "0x" || onchain.length < 2) {
        throw new Error("Nothing is deployed at that address.");
    }

    const { file, long } = await resolve(request.compilerVersion);
    const soljson = await download(file, cacheDir);
    const { input, sources } = buildInput(request);
    const output = await compile(soljson, JSON.stringify(input));

    const fatal = (output.errors ?? []).filter((entry) => entry.severity === "error");
    if (fatal.length > 0) {
        throw new Error(fatal.map((entry) => entry.formattedMessage ?? entry.message).join("\n").trim());
    }

    // `src/Token.sol:Token`, `Token.sol:Token` and `Token` all have to work,
    // because all three are what people have in front of them.
    const wanted = request.contractName.includes(":")
        ? request.contractName.split(":")
        : [ null, request.contractName ];
    const [ wantedFile, wantedName ] = wanted as [ string | null, string ];

    let found: CompiledContract | undefined;
    let foundName = wantedName;
    for (const [ path, contracts ] of Object.entries(output.contracts ?? {})) {
        if (wantedFile && path !== wantedFile) continue;
        const hit = contracts[wantedName];
        if (hit) { found = hit; foundName = wantedName; break; }
    }
    if (!found) {
        const available = Object.entries(output.contracts ?? {})
            .flatMap(([ path, contracts ]) => Object.keys(contracts).map((name) => `${path}:${name}`));
        throw new Error(
            `"${request.contractName}" is not in what was compiled.`
            + (available.length > 0 ? ` Found: ${available.slice(0, 12).join(", ")}.` : ""),
        );
    }

    const compiled = strip(found.evm.deployedBytecode.object ?? "");
    if (compiled.includes("__$")) {
        const names = Object.values(found.evm.deployedBytecode.linkReferences ?? {})
            .flatMap((byFile) => Object.keys(byFile));
        throw new Error(
            `This contract links ${names.join(", ") || "a library"}, so it cannot be compiled to `
            + "the same bytecode without the deployed library address. Add it under `libraries`.",
        );
    }

    const match = compare(compiled, onchain, found.evm.deployedBytecode.immutableReferences ?? {});
    if (!match) {
        throw new Error(
            "The compiled bytecode does not match what is deployed at this address. "
            + "The usual causes are a different compiler version, optimizer settings that "
            + "do not match, or a different version of the source.",
        );
    }

    return {
        address: request.address.toLowerCase(),
        name: foundName,
        abi: JSON.stringify(found.abi),
        compiler: `v${long}`,
        match,
        sources,
    };
}

// ---------------------------------------------------------------------------
// Jobs

/**
 * Submitted verifications, by the guid the caller polls with.
 *
 * In memory on purpose: a job outlives a compile, not a restart, and telling a
 * caller its job is gone is better than pretending a queue survived one.
 */
const jobs = new Map<string, VerificationState & { at: number }>();
const KEEP = 30 * 60 * 1000;

function sweep(): void {
    const cutoff = Date.now() - KEEP;
    for (const [ guid, job ] of jobs) if (job.at < cutoff) jobs.delete(guid);
}

/** Starts a verification and hands back the guid to poll, as Etherscan does. */
export function submitVerification(
    request: VerifyRequest, deployedCode: string, cacheDir: string,
): string {
    sweep();
    const guid = randomUUID().replace(/-/g, "");
    jobs.set(guid, { status: "pending", at: Date.now() });

    void verifyContract(request, deployedCode, cacheDir).then(
        (result) => jobs.set(guid, { status: "pass", result, at: Date.now() }),
        (error: unknown) => jobs.set(guid, {
            status: "fail",
            message: error instanceof Error ? error.message : String(error),
            at: Date.now(),
        }),
    );

    return guid;
}

export function verificationStatus(guid: string): VerificationState | null {
    const job = jobs.get(guid);
    if (!job) return null;
    const { at: _at, ...state } = job;
    return state;
}
