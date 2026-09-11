/*
 * Telling a person when something breaks.
 *
 * Errors used to go to the log and nowhere else, so the first anyone heard of a
 * failing usage flush or a database that stopped answering was a customer.
 * With ALERT_WEBHOOK_URL set, each distinct error is also posted there — a
 * Discord or Slack incoming webhook both accept the body — once per ten minutes
 * per kind, and never more than twenty an hour, so a failure that repeats on
 * every request is a message and not a flood.
 */
const WEBHOOK = () => process.env.ALERT_WEBHOOK_URL;
const QUIET_MS = 10 * 60_000;
const HOURLY_CAP = 20;

const lastSent = new Map<string, number>();
let windowStart = Date.now();
let sentThisWindow = 0;

function describe(detail: unknown): string {
    if (detail instanceof Error) return detail.stack?.split("\n").slice(0, 4).join("\n") ?? detail.message;
    if (typeof detail === "string") return detail;
    try { return JSON.stringify(detail); } catch { return String(detail); }
}

/** Logs, and — if a webhook is configured — tells a person, without repeating itself. */
export function reportError(label: string, ...details: unknown[]): void {
    console.error(label, ...details);

    const url = WEBHOOK();
    if (!url) return;

    const first = details[0] instanceof Error ? details[0].message : describe(details[0] ?? "");
    const key = `${label}|${first}`.slice(0, 300);
    const now = Date.now();
    if (now - (lastSent.get(key) ?? 0) < QUIET_MS) return;
    if (now - windowStart > 3_600_000) { windowStart = now; sentThisWindow = 0; }
    if (sentThisWindow >= HOURLY_CAP) return;
    lastSent.set(key, now);
    sentThisWindow += 1;

    const text = `forkstate engine: ${label}\n${details.map(describe).join("\n")}`.slice(0, 1_900);
    // Both field names: Discord reads `content`, Slack reads `text`.
    void fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "```\n" + text + "\n```", text }),
        signal: AbortSignal.timeout(5_000),
    }).catch(() => {
        // Nowhere left to report a failure to report.
    });
}
