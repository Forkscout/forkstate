/**
 * The console, as one file with no build step.
 *
 * A bundler here would cost more than it buys: the page is a few hundred lines,
 * and keeping it a string means the image ships a Node runtime and nothing else.
 */
export const UI = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>forkstate</title>
<style>
:root {
    color-scheme: light dark;
    --bg: #fbfbfa; --panel: #fff; --line: #e7e5e1; --ink: #1a1917;
    --dim: #6f6b66; --accent: #b4530a; --good: #2f7d4f; --bad: #b4271f;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
    :root {
        --bg: #171614; --panel: #1f1e1b; --line: #33312d; --ink: #eceae6;
        --dim: #97928b; --accent: #e8963f; --good: #6cc08a; --bad: #e8756c;
    }
}
* { box-sizing: border-box; }
body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
header {
    border-bottom: 1px solid var(--line); padding: 14px 20px;
    display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap;
}
h1 { font-size: 15px; margin: 0; letter-spacing: -.01em; }
h1 span { color: var(--dim); font-weight: 400; }
.stats { margin-left: auto; color: var(--dim); font: 12px/1.4 var(--mono); }
main { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 20px; padding: 20px; align-items: start; }
@media (max-width: 860px) { main { grid-template-columns: 1fr; } }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
.panel > h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--dim);
    margin: 0; padding: 11px 14px; border-bottom: 1px solid var(--line); font-weight: 600;
}
.body { padding: 14px; }
/* Without a cap, a few dozen forks push the panel you came to use off the screen. */
#list { max-height: min(48vh, 420px); overflow-y: auto; }
.env {
    display: block; width: 100%; text-align: left; background: none; border: 0;
    border-bottom: 1px solid var(--line); padding: 11px 14px; cursor: pointer; color: inherit; font: inherit;
}
.env:last-child { border-bottom: 0; }
.env:hover { background: color-mix(in srgb, var(--accent) 7%, transparent); }
.env[aria-current="true"] { background: color-mix(in srgb, var(--accent) 12%, transparent); box-shadow: inset 3px 0 0 var(--accent); }
.env b { font-weight: 600; }
.env small { display: block; color: var(--dim); font-family: var(--mono); font-size: 11.5px; }
label { display: block; font-size: 12px; color: var(--dim); margin: 10px 0 3px; }
label.inline { display: inline-flex; align-items: center; gap: 6px; width: auto; margin: 10px 0 0; cursor: pointer; }
label.inline input { width: auto; margin: 0; }
input, select, textarea {
    width: 100%; padding: 7px 9px; border: 1px solid var(--line); border-radius: 6px;
    background: var(--bg); color: var(--ink); font: 13px var(--mono);
}
textarea { resize: vertical; min-height: 62px; }
button.go {
    margin-top: 12px; padding: 8px 13px; border: 1px solid transparent; border-radius: 6px;
    background: var(--accent); color: #fff; font: 600 13px/1 inherit; cursor: pointer;
}
button.go:hover { filter: brightness(1.08); }
button.go.quiet { background: none; border-color: var(--line); color: var(--ink); }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: end; }
.row > * { flex: 1 1 130px; }
.row > button { flex: 0 0 auto; }
.tabs { display: flex; gap: 2px; padding: 8px 8px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.tabs button {
    background: none; border: 0; border-bottom: 2px solid transparent; color: var(--dim);
    padding: 7px 11px; font: 500 13px inherit; cursor: pointer; border-radius: 5px 5px 0 0;
}
.tabs button[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--accent); }
dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 0; }
dt { color: var(--dim); font-size: 12.5px; }
dd { margin: 0; font-family: var(--mono); font-size: 12.5px; overflow-wrap: anywhere; }
pre {
    margin: 12px 0 0; padding: 11px; background: var(--bg); border: 1px solid var(--line);
    border-radius: 6px; font: 12px/1.5 var(--mono); overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere;
}
.ok { color: var(--good); } .err { color: var(--bad); }
.empty { color: var(--dim); padding: 22px 14px; text-align: center; }
.copy { cursor: pointer; border: 0; background: none; color: var(--accent); font: inherit; padding: 0; }
</style>
</head>
<body>
<header>
    <h1>forkstate <span id="sub">loading…</span></h1>
    <div class="stats" id="cache"></div>
</header>

<main>
    <section class="panel">
        <h2>Environments</h2>
        <div id="list"><p class="empty">loading…</p></div>
        <div class="body" style="border-top:1px solid var(--line)">
            <label for="new-name">New fork</label>
            <div class="row">
                <input id="new-name" placeholder="name" autocomplete="off">
                <input id="new-block" placeholder="block (optional)" autocomplete="off">
            </div>
            <div><label class="inline"><input type="checkbox" id="new-follow"> follow the parent's head</label></div>
            <button class="go" id="create">Create</button>
        </div>
    </section>

    <section class="panel">
        <div class="tabs" id="tabs"></div>
        <div class="body" id="panel"><p class="empty">Pick an environment.</p></div>
    </section>
</main>

<script>
const $ = (id) => document.getElementById(id);
let envs = [], current = null, tab = "overview";

const short = (h, n = 10) => !h ? "—" : (h.length > n * 2 ? h.slice(0, n) + "…" + h.slice(-4) : h);
const bytes = (n) => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";

async function rpc(method, params = []) {
    if (!current) throw new Error("No environment selected.");
    const res = await fetch("/" + current, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
}

function out(node, value, bad) {
    const pre = document.createElement("pre");
    pre.className = bad ? "err" : "ok";
    pre.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    node.querySelector("pre")?.remove();
    node.append(pre);
}

/** Runs an action and shows whatever came back, error or not, in the same place. */
function wire(node, run) {
    node.querySelector("button.go")?.addEventListener("click", async (event) => {
        const button = event.currentTarget;
        const label = button.textContent;
        button.disabled = true; button.textContent = "…";
        try { out(node, await run() ?? "done"); }
        catch (error) { out(node, error.message, true); }
        finally {
            button.disabled = false; button.textContent = label;
            // An action is exactly when the overlay size and the cache counters
            // change, so this is the moment the header is worth re-reading.
            loadList(); loadCache();
        }
    });
}

async function loadList() {
    const data = await fetch("/environments").then((r) => r.json());
    envs = data.environments;
    const list = $("list");
    list.textContent = "";
    if (!envs.length) { list.innerHTML = '<p class="empty">No environments yet.</p>'; return; }
    for (const env of envs) {
        const item = document.createElement("button");
        item.className = "env";
        item.setAttribute("aria-current", String(env.id === current));
        item.innerHTML = "<b></b><small></small>";
        item.querySelector("b").textContent = env.name;
        item.querySelector("small").textContent =
            env.id + " · chain " + env.chainId + " · " + bytes(env.bytes);
        item.addEventListener("click", () => { current = env.id; render(); });
        list.append(item);
    }
}

async function loadCache() {
    if (!current) return;
    try {
        const c = await rpc("forkstate_cache");
        $("cache").textContent =
            c.hits + " cache hits · " + c.misses + " upstream reads · " + c.entries + " entries";
    } catch { $("cache").textContent = ""; }
}

const TABS = {
    overview: "Overview",
    accounts: "Accounts",
    storage: "Storage",
    call: "Call",
    time: "Blocks & time",
    snapshots: "Snapshots",
};

/** Returns a promise, because a panel that loads asynchronously is not drawn yet. */
function render() {
    $("tabs").textContent = "";
    for (const [key, label] of Object.entries(TABS)) {
        const button = document.createElement("button");
        button.textContent = label;
        button.setAttribute("aria-selected", String(key === tab));
        button.addEventListener("click", () => { tab = key; render(); });
        $("tabs").append(button);
    }
    loadList();
    loadCache();
    const panel = $("panel");
    panel.textContent = "";
    if (!current) { panel.innerHTML = '<p class="empty">Pick an environment.</p>'; return; }
    return PANELS[tab](panel);
}

const PANELS = {
    async overview(panel) {
        const info = await rpc("forkstate_info");
        const url = location.origin + "/" + current;
        panel.innerHTML =
            "<dl>" +
            "<dt>RPC URL</dt><dd><button class='copy' id='cp'></button></dd>" +
            "<dt>Chain</dt><dd id='ch'></dd>" +
            "<dt>Forked at</dt><dd id='fb'></dd>" +
            "<dt>Local blocks</dt><dd id='bn'></dd>" +
            "<dt>Overlay</dt><dd id='sz'></dd>" +
            "<dt>Parent head</dt><dd>" +
            "<label class='inline'><input type='checkbox' id='follow'> follow it</label>" +
            " <button class='copy' id='syncnow'>sync now</button></dd>" +
            "</dl>";
        $("cp").textContent = url;
        $("cp").title = "Copy";
        $("cp").addEventListener("click", () => navigator.clipboard.writeText(url));
        $("ch").textContent = info.chainId;
        $("fb").textContent = info.forkBlock + " (" + BigInt(info.forkBlock) + ")";
        $("bn").textContent = info.blockNumber;
        $("sz").textContent =
            info.size.accounts + " accounts · " + info.size.slots + " slots · " + bytes(info.size.bytes);

        $("follow").checked = Boolean(info.followsHead);
        $("follow").addEventListener("change", async (event) => {
            await rpc("forkstate_followHead", [event.currentTarget.checked]);
        });
        $("syncnow").addEventListener("click", async () => {
            try {
                const moved = await rpc("forkstate_sync");
                // Re-render, or "Forked at" keeps showing the block we just left —
                // awaited, or the message lands before the panel is redrawn over it.
                await render();
                out($("panel"), moved.advanced
                    ? "moved from " + moved.from + " to " + moved.to
                    : "already at the parent's head");
            } catch (error) { out(panel, error.message, true); }
        });

        const del = document.createElement("button");
        del.className = "go quiet";
        del.textContent = "Delete this environment";
        del.addEventListener("click", async () => {
            await fetch("/environments/" + current, { method: "DELETE" });
            current = null; render();
        });
        panel.append(del);
    },

    accounts(panel) {
        panel.innerHTML =
            "<label for='a-who'>Address</label><input id='a-who' placeholder='0x…' autocomplete='off'>" +
            "<div class='row'>" +
            "<div><label for='a-what'>Set</label><select id='a-what'>" +
            "<option value='anvil_setBalance'>balance</option>" +
            "<option value='anvil_setNonce'>nonce</option>" +
            "<option value='anvil_setCode'>code</option>" +
            "</select></div>" +
            "<div><label for='a-val'>Value</label><input id='a-val' placeholder='0x…' autocomplete='off'></div>" +
            "</div><button class='go'>Apply</button>";
        wire(panel, async () => {
            const who = $("a-who").value.trim();
            await rpc($("a-what").value, [who, $("a-val").value.trim()]);
            return {
                balance: await rpc("eth_getBalance", [who, "latest"]),
                nonce: await rpc("eth_getTransactionCount", [who, "latest"]),
            };
        });
    },

    storage(panel) {
        panel.innerHTML =
            "<label for='s-addr'>Contract</label><input id='s-addr' placeholder='0x…' autocomplete='off'>" +
            "<div class='row'>" +
            "<div><label for='s-slot'>Slot</label><input id='s-slot' placeholder='0x…' autocomplete='off'></div>" +
            "<div><label for='s-val'>Value (blank to read)</label><input id='s-val' placeholder='0x…' autocomplete='off'></div>" +
            "</div><button class='go'>Read / write</button>";
        wire(panel, async () => {
            const [addr, slot, value] = ["s-addr", "s-slot", "s-val"].map((id) => $(id).value.trim());
            if (value) await rpc("anvil_setStorageAt", [addr, slot, value]);
            return await rpc("eth_getStorageAt", [addr, slot, "latest"]);
        });
    },

    call(panel) {
        panel.innerHTML =
            "<div class='row'>" +
            "<div><label for='c-from'>From (optional)</label><input id='c-from' placeholder='0x…' autocomplete='off'></div>" +
            "<div><label for='c-to'>To</label><input id='c-to' placeholder='0x…' autocomplete='off'></div>" +
            "</div>" +
            "<label for='c-data'>Calldata</label><textarea id='c-data' placeholder='0x…'></textarea>" +
            "<div class='row'>" +
            "<div><label for='c-value'>Value</label><input id='c-value' placeholder='0x0' autocomplete='off'></div>" +
            "<div><label for='c-mode'>Mode</label><select id='c-mode'>" +
            "<option value='eth_call'>call (no state change)</option>" +
            "<option value='eth_sendTransaction'>send (writes state)</option>" +
            "</select></div>" +
            "</div><button class='go'>Run</button>";
        wire(panel, async () => {
            const tx = { to: $("c-to").value.trim(), data: $("c-data").value.trim() || "0x" };
            if ($("c-from").value.trim()) tx.from = $("c-from").value.trim();
            if ($("c-value").value.trim()) tx.value = $("c-value").value.trim();
            const mode = $("c-mode").value;
            if (mode === "eth_call") return await rpc("eth_call", [tx, "latest"]);
            const hash = await rpc("eth_sendTransaction", [tx]);
            return await rpc("eth_getTransactionReceipt", [hash]);
        });
    },

    time(panel) {
        panel.innerHTML =
            "<div class='row'>" +
            "<div><label for='t-blocks'>Mine blocks</label><input id='t-blocks' value='1' autocomplete='off'></div>" +
            "<div><label for='t-secs'>Jump forward (seconds)</label><input id='t-secs' value='0' autocomplete='off'></div>" +
            "</div><button class='go'>Advance</button>";
        wire(panel, async () => {
            const seconds = Number($("t-secs").value || 0);
            if (seconds) await rpc("evm_increaseTime", [seconds]);
            const blocks = Number($("t-blocks").value || 0);
            for (let i = 0; i < blocks; i++) await rpc("evm_mine", []);
            return {
                blockNumber: await rpc("eth_blockNumber"),
                timestamp: (await rpc("eth_getBlockByNumber", ["latest", false]))?.timestamp,
            };
        });
    },

    snapshots(panel) {
        panel.innerHTML =
            "<label for='n-id'>Snapshot id</label>" +
            "<div class='row'><input id='n-id' placeholder='0x1' autocomplete='off'>" +
            "<button class='go quiet' id='take'>Take</button></div>" +
            "<button class='go'>Revert to it</button>";
        panel.querySelector("#take").addEventListener("click", async () => {
            try { $("n-id").value = await rpc("evm_snapshot"); out(panel, "snapshot " + $("n-id").value); }
            catch (error) { out(panel, error.message, true); }
        });
        wire(panel, async () => ({ reverted: await rpc("evm_revert", [$("n-id").value.trim()]) }));
    },
};

$("create").addEventListener("click", async () => {
    const body = {};
    if ($("new-name").value.trim()) body.name = $("new-name").value.trim();
    if ($("new-block").value.trim()) body.forkBlock = $("new-block").value.trim();
    if ($("new-follow").checked) body.followHead = true;
    const created = await fetch("/environments", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => r.json());
    $("new-name").value = ""; $("new-block").value = ""; $("new-follow").checked = false;
    current = created.id; tab = "overview"; render();
});

(async () => {
    await loadList();
    current = envs.find((e) => e.id === "default")?.id ?? envs[0]?.id ?? null;
    const head = envs.find((e) => e.id === current);
    $("sub").textContent = head ? "chain " + head.chainId + " · " + envs.length + " environment(s)" : "no environments";
    render();
})();
</script>
</body>
</html>`;
