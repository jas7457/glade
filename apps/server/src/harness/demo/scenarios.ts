/**
 * The demo's scripted conversations (I-209), about "Lantern", a made-up open-source uptime
 * monitor (TypeScript, Hono, SQLite, Preact) whose repo the demo sandbox creates
 * (scripts/sandbox/demo/repos/lantern). Edits are written against that repo's files, so the diffs,
 * the changes panel and worktrees are real.
 *
 * - `history` scenarios are seeded into the sidebar when the demo sandbox starts (played fast);
 * - `live` ones are what the capture scripts type, played at a realistic pace.
 * A scenario is picked by its `match` on the prompt (and its `agent`, when set); sub-agents are
 * picked by the name they were spawned with. Replies read like a strong coding agent's work.
 */
import type { ToolEdit } from "@glade/protocol";
import { DEMO_AGENTS, type DemoAgent } from "./agents.js";
import type { DemoStep, DemoTool } from "./player.js";

export interface DemoScenario {
  id: string;
  /** The prompt that plays it (tested against the trimmed text). */
  match: RegExp;
  /** Only for this agent (default: any). */
  agent?: DemoAgent["id"];
  /** Chat title (titles are "generated" from it). */
  title: string;
  /** How long "generating" the title takes (ms; default instant), so the quick title shows first. */
  titleMs?: number;
  pace: "history" | "live";
  steps: (t: Tools) => DemoStep[];
  /** Played when every sub-agent this turn spawned has reported. */
  afterReports?: (t: Tools) => DemoStep[];
}

export interface DemoSubagentScript {
  /** The `name` it was spawned with. */
  name: string;
  /** Its tab title. */
  title: string;
  pace: "history" | "live";
  /** Real time before it reports (ms), however fast it's played. */
  minMs?: number;
  steps: (t: Tools) => DemoStep[];
}

/** Tool-call builders in one agent's own vocabulary (pi's `read`, Claude's `Read`, Codex's `shell`). */
export interface Tools {
  read(path: string, opts?: { ms?: number; offset?: number; limit?: number }): DemoTool;
  edit(path: string, edits: ToolEdit[], ms?: number): DemoTool;
  write(path: string, content: string, ms?: number): DemoTool;
  sh(command: string, output: string, ms?: number, error?: boolean): DemoTool;
  grep(pattern: string, path: string, output: string, ms?: number): DemoTool;
  ls(path: string, output: string, ms?: number): DemoTool;
}

export function toolsFor(agent: DemoAgent): Tools {
  const n = agent.tools;
  const codex = agent.id === "codex";
  return {
    read: (path, opts = {}) =>
      codex
        ? { kind: "read", name: n.read, input: { path }, args: { command: ["/bin/zsh", "-lc", `sed -n '1,200p' ${path}`] }, ms: opts.ms ?? 260 }
        : { kind: "read", name: n.read, input: { path, ...(opts.offset ? { offset: opts.offset } : {}), ...(opts.limit ? { limit: opts.limit } : {}) }, ms: opts.ms ?? 320 },
    edit: (path, edits, ms = 380) => ({ kind: "edit", name: n.edit, input: { path, edits }, ms }),
    write: (path, content, ms = 380) => ({ kind: "write", name: n.write, input: { path, content }, ms }),
    sh: (command, output, ms = 900, error = false) => ({ kind: "shell", name: n.shell, input: { command }, output, ms, error }),
    grep: (pattern, path, output, ms = 300) =>
      codex
        ? { kind: "search", name: n.search, input: { pattern, path }, args: { command: ["/bin/zsh", "-lc", `rg -n "${pattern}" ${path}`] }, output, ms }
        : { kind: "search", name: n.search, input: { pattern, path }, output, ms },
    ls: (path, output, ms = 200) => ({ kind: "list", name: n.list, input: { path }, output, ms }),
  };
}

// ---------------------------------------------------------------------------------------------
// Shared file contents
// ---------------------------------------------------------------------------------------------

const BACKOFF_TS = `/** Delay before retry number \`attempt\` (0-based): base, 2×base, 4×base…, capped at \`maxMs\`. */
export function backoffDelay(attempt: number, baseMs: number, maxMs = 30_000): number {
  return Math.min(maxMs, baseMs * 2 ** attempt);
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
`;

const BACKOFF_TEST_TS = `import { describe, expect, it } from "vitest";
import { backoffDelay } from "../src/util/backoff.js";

describe("backoffDelay", () => {
  it("doubles the delay on every attempt", () => {
    expect([0, 1, 2, 3].map((n) => backoffDelay(n, 500))).toEqual([500, 1000, 2000, 4000]);
  });

  it("caps the delay", () => {
    expect(backoffDelay(10, 500)).toBe(30_000);
    expect(backoffDelay(3, 500, 2_000)).toBe(2_000);
  });
});
`;

const VITEST = (files: Array<[string, number, number]>, at: string) => {
  const tests = files.reduce((s, [, n]) => s + n, 0);
  return `
> lantern@0.9.0 test
> vitest run


 RUN  v3.1.2

${files.map(([f, n, ms]) => ` ✓ ${f} (${n} test${n === 1 ? "" : "s"}) ${ms}ms`).join("\n")}

 Test Files  ${files.length} passed (${files.length})
      Tests  ${tests} passed (${tests})
   Start at  ${at}
   Duration  ${380 + files.length * 41}ms (transform 92ms, setup 0ms, collect 140ms, tests 31ms, environment 0ms, prepare 64ms)
`;
};

// ---------------------------------------------------------------------------------------------
// History: seeded chats
// ---------------------------------------------------------------------------------------------

const retries: DemoScenario = {
  id: "retries",
  agent: "pi",
  match: /^Checks against slow endpoints keep flapping/,
  title: "Retry flaky checks with backoff",
  pace: "history",
  steps: (t) => [
    {
      think:
        "Flapping means a single failed request flips the check's state, and the scheduler notifies on every flip. The fix belongs in the check runner rather than the scheduler: retry inside `runHttpCheck` so a check only counts as down after several failed attempts in a row. Let me read the runner, the scheduler and the config types before changing anything.",
    },
    {
      tools: [
        t.read("src/checks/http.ts"),
        t.read("src/checks/scheduler.ts"),
        t.read("src/config.ts"),
        t.grep("timeoutMs", "src", "src/config.ts:10:  timeoutMs: number;\nsrc/config.ts:27:const DEFAULT_CHECK = { intervalSec: 60, timeoutMs: 10_000 };\nsrc/checks/http.ts:20:      signal: AbortSignal.timeout(check.timeoutMs),\nsrc/cli.ts:28:  const result = await runHttpCheck({ id: \"adhoc\", name: args[0], url: args[0], intervalSec: 0, timeoutMs: 10_000 });\n"),
      ],
    },
    {
      think:
        "`runHttpCheck` makes exactly one request and the scheduler records whatever comes back, so one slow response is enough to flip the state. Retrying in the runner keeps the scheduler untouched and means only the final attempt is recorded. Exponential backoff with a small base (500 ms) and two retries keeps the worst case well below the shortest interval (30 s).",
    },
    { say: "The runner makes a single request, so one slow response flips the check. I'll add a small backoff helper, retry inside `runHttpCheck`, and make the retry count and delay configurable per check." },
    { tools: [t.write("src/util/backoff.ts", BACKOFF_TS)] },
    {
      tools: [
        t.edit("src/config.ts", [
          {
            oldText: "  expectStatus?: [number, number];\n}",
            newText:
              "  expectStatus?: [number, number];\n  /** Extra attempts before the check counts as down (default 2). */\n  retries?: number;\n  /** Delay before the first retry; doubles on every attempt (default 500 ms). */\n  retryDelayMs?: number;\n}",
          },
          { oldText: "const DEFAULT_CHECK = { intervalSec: 60, timeoutMs: 10_000 };", newText: "const DEFAULT_CHECK = { intervalSec: 60, timeoutMs: 10_000, retries: 2, retryDelayMs: 500 };" },
        ]),
        t.edit("src/checks/http.ts", [
          { oldText: 'import type { CheckConfig } from "../config.js";', newText: 'import type { CheckConfig } from "../config.js";\nimport { backoffDelay, sleep } from "../util/backoff.js";' },
          {
            oldText: "export async function runHttpCheck(check: CheckConfig): Promise<CheckResult> {\n  const started = performance.now();",
            newText:
              "/** Runs the check, retrying failed attempts with exponential backoff; returns the last attempt. */\nexport async function runHttpCheck(check: CheckConfig): Promise<CheckResult> {\n  let result = await attempt(check);\n  for (let i = 0; i < (check.retries ?? 0) && !result.ok; i++) {\n    await sleep(backoffDelay(i, check.retryDelayMs ?? 500));\n    result = await attempt(check);\n  }\n  return result;\n}\n\nasync function attempt(check: CheckConfig): Promise<CheckResult> {\n  const started = performance.now();",
          },
        ]),
      ],
    },
    { say: "Now tests for the helper and for the retry path itself." },
    {
      tools: [
        t.write("test/backoff.test.ts", BACKOFF_TEST_TS),
        t.edit("test/http.test.ts", [
          {
            oldText: '  it("reports network errors", async () => {',
            newText:
              '  it("retries a failed attempt before reporting down", async () => {\n    const fetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValue(new Response("ok"));\n    vi.stubGlobal("fetch", fetch);\n    const result = await runHttpCheck({ ...check, retries: 2, retryDelayMs: 1 });\n    expect(result.ok).toBe(true);\n    expect(fetch).toHaveBeenCalledTimes(2);\n  });\n\n  it("gives up after the last retry", async () => {\n    const fetch = vi.fn().mockResolvedValue(new Response("", { status: 503 }));\n    vi.stubGlobal("fetch", fetch);\n    expect((await runHttpCheck({ ...check, retries: 2, retryDelayMs: 1 })).ok).toBe(false);\n    expect(fetch).toHaveBeenCalledTimes(3);\n  });\n\n  it("reports network errors", async () => {',
          },
        ]),
      ],
    },
    { tools: [t.sh("pnpm test", VITEST([["test/backoff.test.ts", 2, 3], ["test/http.test.ts", 5, 14], ["test/scheduler.test.ts", 1, 9]], "10:42:18"), 2400)] },
    {
      say: `Checks now retry before they count as down, so a single slow response no longer flips the state or pings Slack.

**What changed**
- \`src/util/backoff.ts\`: \`backoffDelay(attempt, base)\` doubles the delay on every attempt (capped at 30 s), plus a tiny \`sleep\`.
- \`src/checks/http.ts\`: \`runHttpCheck\` retries a failed attempt up to \`retries\` times; only the last attempt is recorded.
- \`src/config.ts\`: two new per-check options:

| Option | Default | Meaning |
| --- | --- | --- |
| \`retries\` | 2 | Extra attempts before a check counts as down |
| \`retryDelayMs\` | 500 | Delay before the first retry; doubles each time (500 → 1000 ms) |

**Tests:** two new cases for the retry path plus the backoff helper; all 8 pass.

One trade-off to keep in mind: with the defaults, a dead endpoint takes up to \`3 × timeoutMs + 1.5 s\` to be reported. For the API check (5 s timeout) that's about 16.5 s, well under its 30 s interval, so runs never overlap.`,
    },
  ],
};

const audit: DemoScenario = {
  id: "audit",
  agent: "pi",
  match: /^Before we tag 1\.0/,
  title: "Pre-1.0 audit with three reviewers",
  pace: "history",
  steps: (t) => [
    {
      think:
        "Three independent areas, no shared files to edit: a good fit for parallel reviewers. Each one should only read and report, so nothing conflicts. I'll give each a narrow brief with the files to start from and ask for findings ranked by severity.",
    },
    { tools: [t.ls(".", "README.md\nlantern.config.example.json\npackage.json\nsrc/\ntest/\ntsconfig.json\nweb/\n")] },
    {
      spawn: [
        { name: "notifier-review", task: "Review the notifiers (src/notify/) for error handling: what happens when Slack or a webhook is slow, down or returns an error? Read only; report findings ranked by severity with file:line." },
        { name: "scheduler-review", task: "Review the scheduler (src/checks/scheduler.ts) for timer bugs: overlapping runs, drift, state lost on restart. Read only; report findings ranked by severity with file:line." },
        { name: "a11y-review", task: "Review the dashboard (web/src/) for accessibility: screen readers, colour-only signals, live updates. Read only; report findings ranked by severity with file:line." },
      ],
    },
    { say: "Three reviewers are on it: notifiers, scheduler and dashboard accessibility. I'll merge their findings when they report." },
  ],
  afterReports: () => [
    {
      think:
        "All three are in. The two notifier issues are the only ones that can make Lantern miss an alert entirely, so they go first. The scheduler overlap is real but needs a slow check plus a short interval. The a11y items are quick wins.",
    },
    {
      say: `All three reviews are in. Two findings can make Lantern miss an alert; the rest are smaller. Ranked:

| # | Finding | Severity |
| --- | --- | --- |
| 1 | **Notifiers:** \`Promise.all\` lets one failing Slack call reject the whole send | **High** |
| 2 | **Notifiers:** no timeout on the webhook \`fetch\`; a hung endpoint stalls the tick | **High** |
| 3 | **Scheduler:** \`setInterval\` lets a slow check overlap its next run | Medium |
| 4 | **Scheduler:** a check that fails during a restart never alerts | Medium |
| 5 | **Dashboard:** the uptime chart has no accessible name | Medium |
| 6 | **Dashboard:** status changes aren't announced (no \`aria-live\`) | Low |

#1 and #2 are the only ones that can make Lantern **miss an alert**, so I'd fix those before tagging. Want me to?`,
    },
  ],
};

const auditFix: DemoScenario = {
  id: "audit-fix",
  agent: "pi",
  match: /^Yes, fix 1 and 2/,
  title: "Pre-1.0 audit with three reviewers",
  pace: "history",
  steps: (t) => [
    { think: "Use `Promise.allSettled` so one target can't sink the others, log failures with the target's type, and give every outgoing request a timeout through one helper." },
    {
      tools: [
        t.edit("src/notify/index.ts", [
          {
            oldText: "    async send(alert) {\n      await Promise.all(targets.map((t) => t.send(alert)));\n    },",
            newText:
              "    async send(alert) {\n      // One failing target must not stop the others (or escape into the scheduler).\n      const results = await Promise.allSettled(targets.map((t) => t.send(alert)));\n      results.forEach((r, i) => {\n        if (r.status === \"rejected\") console.error(`lantern: ${configs[i]!.type} notifier failed:`, r.reason);\n      });\n    },",
          },
        ]),
        t.edit("src/notify/webhook.ts", [
          { oldText: '        headers: { "content-type": "application/json", ...headers },', newText: '        headers: { "content-type": "application/json", ...headers },\n        signal: AbortSignal.timeout(10_000),' },
        ]),
        t.edit("src/notify/slack.ts", [
          { oldText: '        headers: { "content-type": "application/json" },', newText: '        headers: { "content-type": "application/json" },\n        signal: AbortSignal.timeout(10_000),' },
        ]),
      ],
    },
    { tools: [t.sh("pnpm test", VITEST([["test/backoff.test.ts", 2, 3], ["test/http.test.ts", 5, 13], ["test/scheduler.test.ts", 1, 9]], "11:07:52"), 2200)] },
    {
      say: "Fixed both:\n\n- **Notifiers are isolated**: `createNotifier` now uses `Promise.allSettled` and logs each failed target, so a Slack outage can't stop the webhook (or crash the tick).\n- **Every notification has a 10 s timeout** (`AbortSignal.timeout`) in both the Slack and webhook notifiers.\n\nTests pass. #3 (overlapping runs) is next on my list if you want it before the tag; it's a small change to schedule each run after the previous one finishes.",
    },
  ],
};

const chartFlicker: DemoScenario = {
  id: "chart",
  agent: "claude",
  match: /^The uptime chart flickers/,
  title: "Fix uptime chart flicker",
  pace: "history",
  steps: (t) => [
    { think: "Flicker on every new point usually means the whole SVG re-renders or rescales. Let me look at the chart component and how it's fed." },
    {
      tools: [
        t.read("web/src/components/UptimeChart.tsx"),
        t.grep("UptimeChart", "web/src", 'web/src/App.tsx:3:import { UptimeChart } from "./components/UptimeChart";\nweb/src/App.tsx:36:          <UptimeChart checkId={check.id} />\nweb/src/components/UptimeChart.tsx:12:export function UptimeChart({ checkId }: { checkId: string }) {\n'),
      ],
    },
    {
      think:
        "Three things happen on each message: `key={i}` means that once the window is full and slides, every bar's key now points at a different point, so Preact patches all 90 rects at once. `max` is recomputed from the visible points, so a single spike rescales every bar. And the SVG's width grows with the number of points until the window is full, which shifts the layout. None of it is a re-mount, but together it reads as a flicker.",
    },
    {
      say: `Found it. Every new point triggers three visual changes at once:

1. **Index keys.** Once 90 points are on screen, \`slice(-90)\` shifts the window, so with \`key={i}\` every \`<rect>\` gets a different point's \`x\`/\`height\`: all 90 bars repaint.
2. **Unstable scale.** \`max\` is the largest latency *on screen*, so one slow response rescales every bar, and the next one rescales them back.
3. **Growing width.** The SVG is \`points.length × 5\` px wide, so the layout shifts until the window is full.

I'll key bars by timestamp, round the scale up to a stable ceiling, and give the SVG a fixed \`viewBox\`.`,
    },
    {
      tools: [
        t.edit("web/src/components/UptimeChart.tsx", [
          { oldText: "const BAR_WIDTH = 4;\nconst HEIGHT = 48;", newText: "const BAR_WIDTH = 4;\nconst HEIGHT = 48;\nconst WINDOW = 90;\n\n/** Rounds up to 100, 200, 500, 1000… so one spike doesn't rescale the whole chart. */\nfunction niceCeiling(ms: number): number {\n  const step = 10 ** Math.floor(Math.log10(Math.max(ms, 1)));\n  return [1, 2, 5, 10].map((m) => m * step).find((v) => v >= ms)!;\n}" },
          { oldText: "    source.onmessage = (e) => setPoints((prev) => [...prev, JSON.parse(e.data)].slice(-90));", newText: "    source.onmessage = (e) => setPoints((prev) => [...prev, JSON.parse(e.data)].slice(-WINDOW));" },
          {
            oldText:
              "  const max = Math.max(...points.map((p) => p.latencyMs), 1);\n  return (\n    <svg class=\"uptime-chart\" width={points.length * (BAR_WIDTH + 1)} height={HEIGHT}>\n      {points.map((p, i) => (\n        <rect\n          key={i}\n          x={i * (BAR_WIDTH + 1)}",
            newText:
              "  const max = niceCeiling(Math.max(...points.map((p) => p.latencyMs), 100));\n  const offset = WINDOW - points.length; // new points enter on the right\n  return (\n    <svg class=\"uptime-chart\" viewBox={`0 0 ${WINDOW * (BAR_WIDTH + 1)} ${HEIGHT}`} role=\"img\" aria-label={`Latency, last ${points.length} checks`}>\n      {points.map((p, i) => (\n        <rect\n          key={p.at}\n          x={(offset + i) * (BAR_WIDTH + 1)}",
          },
        ]),
      ],
    },
    { tools: [t.sh("pnpm exec tsc --noEmit -p web", "", 2100), t.sh("pnpm test", VITEST([["test/backoff.test.ts", 2, 3], ["test/http.test.ts", 5, 12], ["test/scheduler.test.ts", 1, 9]], "11:31:04"), 2600)] },
    {
      say: "Fixed in `web/src/components/UptimeChart.tsx`:\n\n- bars are keyed by their timestamp, so a new point adds one `<rect>` and drops one instead of repainting all 90;\n- the scale rounds up to a stable ceiling (100 / 200 / 500 / 1000 ms…), so a single spike no longer rescales the chart;\n- the SVG has a fixed `viewBox` and new points enter from the right, so nothing shifts while the window fills.\n\nI also gave the chart an accessible name while I was there. Type check and tests pass.",
    },
  ],
};

const region: DemoScenario = {
  id: "region",
  agent: "codex",
  match: /^We're about to run Lantern from two regions/,
  title: "Record the region of each result",
  pace: "history",
  steps: (t) => [
    { think: "Need to see the schema and the insert path, then add a nullable column with an idempotent migration." },
    {
      tools: [
        t.grep("CREATE TABLE|INSERT INTO|ALTER TABLE", "src", 'src/store.ts:13:      CREATE TABLE IF NOT EXISTS results (\nsrc/store.ts:27:      .prepare("INSERT INTO results (check_id, ok, status, latency_ms, error, at) VALUES (?, ?, ?, ?, ?, ?)")\n'),
        t.read("src/store.ts"),
        t.read("src/checks/http.ts"),
      ],
    },
    { say: "Plan: nullable `region` column added on open (SQLite has no `ADD COLUMN IF NOT EXISTS`, so check `PRAGMA table_info` first), set from `LANTERN_REGION` on every insert, and returned in `history()`." },
    {
      tools: [
        t.edit("src/store.ts", [
          {
            oldText: "      CREATE INDEX IF NOT EXISTS results_check_at ON results (check_id, at);\n    `);\n  }",
            newText:
              "      CREATE INDEX IF NOT EXISTS results_check_at ON results (check_id, at);\n    `);\n    // v0.10: which region ran the check (null for older rows).\n    const columns = this.db.prepare(\"PRAGMA table_info(results)\").all() as Array<{ name: string }>;\n    if (!columns.some((c) => c.name === \"region\")) this.db.exec(\"ALTER TABLE results ADD COLUMN region TEXT\");\n  }",
          },
          {
            oldText:
              '      .prepare("INSERT INTO results (check_id, ok, status, latency_ms, error, at) VALUES (?, ?, ?, ?, ?, ?)")\n      .run(result.checkId, result.ok ? 1 : 0, result.status, result.latencyMs, result.error ?? null, result.at);',
            newText:
              '      .prepare("INSERT INTO results (check_id, ok, status, latency_ms, error, at, region) VALUES (?, ?, ?, ?, ?, ?, ?)")\n      .run(result.checkId, result.ok ? 1 : 0, result.status, result.latencyMs, result.error ?? null, result.at, REGION);',
          },
          { oldText: "const RETENTION_DAYS = 30;", newText: "const RETENTION_DAYS = 30;\n/** Where this instance runs (`LANTERN_REGION`, e.g. \"eu-west\"); stored with every result. */\nconst REGION = process.env.LANTERN_REGION ?? null;" },
          { oldText: '"SELECT check_id AS checkId, ok, status, latency_ms AS latencyMs, error, at FROM results', newText: '"SELECT check_id AS checkId, ok, status, latency_ms AS latencyMs, error, at, region FROM results' },
        ]),
        t.edit("src/checks/http.ts", [{ oldText: "  error?: string;\n  at: number;\n}", newText: "  error?: string;\n  at: number;\n  /** Region that ran the check (`LANTERN_REGION`); null for older results. */\n  region?: string | null;\n}" }]),
      ],
    },
    { tools: [t.sh("pnpm test", VITEST([["test/backoff.test.ts", 2, 3], ["test/http.test.ts", 5, 12], ["test/scheduler.test.ts", 1, 8]], "13:12:40"), 2300)] },
    {
      say: "Done.\n\n- `src/store.ts`: new nullable `region` column, added on startup when missing (checked with `PRAGMA table_info`, so it's safe to run repeatedly); every insert records `LANTERN_REGION`; `history()` returns it.\n- `src/checks/http.ts`: `CheckResult.region` (optional, null for rows written before this change).\n\nTests pass. Run each instance with `LANTERN_REGION=eu-west` / `us-east`. If you later want per-region uptime in the dashboard, `uptime()` just needs a `region` filter.",
    },
  ],
};

const DISCORD_TS = `import type { Alert, Notifier } from "./index.js";

/** Posts alerts to a Discord channel through an incoming webhook, as an embed. */
export function discordNotifier(webhookUrl: string): Notifier {
  return {
    async send({ check, result, kind }: Alert) {
      const down = kind === "down";
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          username: "Lantern",
          embeds: [
            {
              title: \`\${check.name} is \${down ? "down" : "back up"}\`,
              url: check.url,
              color: down ? 0xe5484d : 0x30a46c,
              description: result.error ?? \`HTTP \${result.status} in \${result.latencyMs} ms\`,
              timestamp: new Date(result.at).toISOString(),
            },
          ],
        }),
      });
      // Discord answers 204; 429 means we're rate limited (retry_after is in the body).
      if (!res.ok) throw new Error(\`Discord webhook answered \${res.status}\`);
    },
  };
}
`;

const discord: DemoScenario = {
  id: "discord",
  agent: "pi",
  match: /^Add a Discord notifier/,
  title: "Discord notifier",
  pace: "history",
  steps: (t) => [
    { think: "Discord's incoming webhooks take a JSON body with `content` or `embeds`. An embed with a colour reads much better than plain text for up/down alerts. I'll follow the Slack notifier's shape and wire it into the config union and the factory." },
    { tools: [t.read("src/notify/slack.ts"), t.read("src/notify/index.ts"), t.read("src/config.ts", { offset: 15, limit: 6 })] },
    { tools: [t.write("src/notify/discord.ts", DISCORD_TS)] },
    {
      tools: [
        t.edit("src/notify/index.ts", [
          { oldText: 'import { slackNotifier } from "./slack.js";', newText: 'import { discordNotifier } from "./discord.js";\nimport { slackNotifier } from "./slack.js";' },
          { oldText: '      case "webhook":\n        return webhookNotifier(config.url, config.headers);', newText: '      case "webhook":\n        return webhookNotifier(config.url, config.headers);\n      case "discord":\n        return discordNotifier(config.webhookUrl);' },
        ]),
        t.edit("src/config.ts", [{ oldText: '  | { type: "slack"; webhookUrl: string }', newText: '  | { type: "slack"; webhookUrl: string }\n  | { type: "discord"; webhookUrl: string }' }]),
        t.edit("lantern.config.example.json", [{ oldText: '    { "type": "slack", "webhookUrl": "https://hooks.slack.com/services/T000/B000/XXXX" },', newText: '    { "type": "slack", "webhookUrl": "https://hooks.slack.com/services/T000/B000/XXXX" },\n    { "type": "discord", "webhookUrl": "https://discord.com/api/webhooks/000/XXXX" },' }]),
      ],
    },
    { tools: [t.sh("pnpm exec tsc --noEmit", "", 1900)] },
    {
      say: "Added a Discord notifier on this branch:\n\n- `src/notify/discord.ts` posts an embed (red when down, green when back up) with the check's URL, the error or status and the time; it throws on a non-2xx answer so failures show up in the logs.\n- Wired into `createNotifier` and the `NotifierConfig` union (`{ \"type\": \"discord\", \"webhookUrl\": \"…\" }`), with an example in `lantern.config.example.json`.\n\nType check passes. The changes are uncommitted in this worktree: review them in the changes panel and commit when you're happy.",
    },
  ],
};

const releaseNotes: DemoScenario = {
  id: "release-notes",
  agent: "pi",
  match: /^Write the release notes for 0\.9\.0/,
  title: "Release notes for 0.9.0",
  pace: "history",
  steps: (t) => [
    {
      tools: [
        t.sh(
          "git log --oneline -8",
          "a41c9e2 Record the region of each result\n7d0b5f1 Fix uptime chart flicker\n3e9a7c0 Isolate notifiers and time out their requests\nc81f2d4 Retry flaky checks with exponential backoff\n5b3d8a9 Dashboard: uptime chart and status badges\n2f6e1c7 Add Slack and webhook notifiers\n9a0c4b3 Store results in SQLite, keep 30 days\ne7d21f8 Initial scaffold: HTTP checks and the scheduler\n",
          500,
        ),
      ],
    },
    {
      say: "## Lantern 0.9.0\n\n### Added\n- **Retries with backoff**: checks retry before they count as down (`retries`, `retryDelayMs`), so a single slow response no longer pages anyone.\n- **Regions**: each result records `LANTERN_REGION`, ready for running Lantern from several locations.\n\n### Fixed\n- The uptime chart no longer flickers when a new result arrives.\n- One failing notifier can't block the others any more, and every notification times out after 10 s.\n\n### Upgrading\nNo config changes needed: the new options have defaults, and the database gains its `region` column on first start.",
    },
  ],
};

const percentiles: DemoScenario = {
  id: "percentiles",
  agent: "claude",
  match: /^Should I alert on p95 or p99/,
  title: "p95 vs p99 for latency alerts",
  pace: "history",
  steps: () => [
    { think: "The question is about alert design, not math. Key points: p99 on low traffic is noisy because it's driven by a handful of requests; p95 is steadier; alerting needs a minimum sample count and a sustained window. For an uptime monitor checking every 30 s, the sample size per window is tiny, which changes the answer." },
    {
      say: `For Lantern's use case, **alert on p95 over a window, and only show p99 on the dashboard.**

The reason is sample size. A check every 30 s gives you 10 samples in 5 minutes:

| Window | Samples | p95 is decided by | p99 is decided by |
| --- | --- | --- | --- |
| 5 min | 10 | the slowest request | the slowest request |
| 1 hour | 120 | the 6th slowest | the 2nd slowest |
| 24 hours | 2,880 | the 144th slowest | the 29th slowest |

With so few samples, p99 is effectively "the single worst response", so one GC pause or cold start pages someone. p95 over an hour is still sensitive to a real slowdown but shrugs off one bad request.

A rule that works well in practice:
- **Page** when p95 over 15 min is above the threshold *and* at least 3 checks failed or were slow (no paging on a single outlier).
- **Warn** (dashboard, no page) when p99 over 1 hour is above the threshold.
- Require **two consecutive windows** before alerting, so a single bad window doesn't flap.`,
    },
  ],
};

const abortTimeout: DemoScenario = {
  id: "abort",
  agent: "codex",
  match: /^AbortSignal\.timeout vs/,
  title: "AbortSignal.timeout vs a manual timer",
  pace: "history",
  steps: () => [
    { think: "Main differences: timer cleanup, the error type (TimeoutError vs AbortError), and combining signals with AbortSignal.any." },
    {
      say: "Prefer `AbortSignal.timeout(ms)` unless you also need to cancel for another reason.\n\n- **Cleanup**: the timeout signal's timer doesn't keep the process alive and needs no `clearTimeout`; with a manual `AbortController` + `setTimeout` you must clear the timer on success or you leak one per request.\n- **Error type**: a timeout rejects with a `DOMException` named `TimeoutError`, a manual `abort()` with `AbortError`, so you can tell \"too slow\" from \"cancelled\" in logs.\n- **Both**: combine them with `AbortSignal.any([AbortSignal.timeout(5_000), controller.signal])`.\n\n```ts\ntry {\n  await fetch(url, { signal: AbortSignal.timeout(5_000) });\n} catch (err) {\n  if (err instanceof DOMException && err.name === \"TimeoutError\") return { ok: false, error: \"timed out\" };\n  throw err;\n}\n```",
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// Live: what the capture scripts type
// ---------------------------------------------------------------------------------------------

const jitter: DemoScenario = {
  id: "jitter",
  agent: "pi",
  match: /^Nice\. Now add jitter/,
  title: "Retry flaky checks with backoff",
  pace: "live",
  steps: (t) => [
    {
      think:
        "Jitter belongs in `backoffDelay`. Full jitter (anywhere between 0 and the delay) spreads retries best but can make a retry immediate; equal jitter keeps at least half the delay. I'll support both and default to equal. The README and the tests don't depend on the code change, so two sub-agents can take them while I do the code.",
    },
    { tools: [t.read("src/util/backoff.ts", { ms: 260 }), t.read("README.md", { ms: 300 }), t.grep("retryDelayMs", "src", "src/config.ts:16:  retryDelayMs?: number;\nsrc/config.ts:32:const DEFAULT_CHECK = { intervalSec: 60, timeoutMs: 10_000, retries: 2, retryDelayMs: 500 };\nsrc/checks/http.ts:17:    await sleep(backoffDelay(i, check.retryDelayMs ?? 500));\n", 340)] },
    {
      spawn: [
        { name: "docs", task: "Document the retry options in README.md: add `retries`, `retryDelayMs` and the new `retryJitter` to the configuration table, plus a short \"Flapping checks\" section on the trade-off. Don't touch code." },
        { name: "tests", task: "Cover backoffDelay's jitter modes in test/backoff.test.ts: equal jitter stays within [d/2, d], full within [0, d], none is exact. Stub Math.random, run the suite and report." },
      ],
    },
    { say: "Docs and tests are with two sub-agents. Now the jitter itself:" },
    {
      tools: [
        t.edit("src/util/backoff.ts", [
          {
            oldText: "/** Delay before retry number `attempt` (0-based): base, 2×base, 4×base…, capped at `maxMs`. */\nexport function backoffDelay(attempt: number, baseMs: number, maxMs = 30_000): number {\n  return Math.min(maxMs, baseMs * 2 ** attempt);\n}",
            newText:
              "export type Jitter = \"none\" | \"equal\" | \"full\";\n\n/**\n * Delay before retry number `attempt` (0-based): base, 2×base, 4×base…, capped at `maxMs`.\n * Jitter spreads retries of checks that failed together: `equal` keeps at least half the delay.\n */\nexport function backoffDelay(attempt: number, baseMs: number, jitter: Jitter = \"equal\", maxMs = 30_000): number {\n  const delay = Math.min(maxMs, baseMs * 2 ** attempt);\n  if (jitter === \"full\") return Math.round(Math.random() * delay);\n  if (jitter === \"equal\") return Math.round(delay / 2 + Math.random() * (delay / 2));\n  return delay;\n}",
          },
        ], 520),
        t.edit("src/config.ts", [{ oldText: "  retryDelayMs?: number;\n}", newText: "  retryDelayMs?: number;\n  /** Randomizes retry delays so checks that fail together don't retry in lockstep (default \"equal\"). */\n  retryJitter?: Jitter;\n}" }, { oldText: 'import { readFileSync } from "node:fs";', newText: 'import { readFileSync } from "node:fs";\nimport type { Jitter } from "./util/backoff.js";' }], 480),
        t.edit("src/checks/http.ts", [{ oldText: "    await sleep(backoffDelay(i, check.retryDelayMs ?? 500));", newText: "    await sleep(backoffDelay(i, check.retryDelayMs ?? 500, check.retryJitter));" }], 440),
      ],
    },
    { tools: [t.sh("pnpm exec tsc --noEmit", "", 1100)] },
    { say: "Types check. Waiting for the docs and tests to come back." },
  ],
  afterReports: () => [
    {
      say: `Jitter is in, documented and tested.

- \`backoffDelay(attempt, base, jitter)\` supports \`none\`, \`equal\` (the default: between half and the full delay) and \`full\`, set per check with \`retryJitter\`.
- **Docs**: the README lists the three retry options, with a short *Flapping checks* section.
- **Tests**: three new cases pin each mode's range; all 11 pass.

Ten checks failing at once now spread their first retry over 250–500 ms instead of all firing at 500 ms.`,
    },
  ],
};

const review: DemoScenario = {
  id: "review",
  match: /^We're about to ship 1\.0/,
  title: "Pre-release review: API, SQLite, tests",
  pace: "live",
  steps: (t) => [
    { think: "Three independent reviews: validation in the API, query performance in the store, and missing tests for the server. They touch different files, so they can run side by side." },
    {
      spawn: [
        { name: "api-review", task: "Check every route in src/server.ts for missing input validation (ids, query params, limits). Report each gap with file:line and a one-line fix." },
        { name: "sqlite-perf", task: "Profile the queries in src/store.ts against 30 days of results for 50 checks: EXPLAIN QUERY PLAN for each, and report anything that scans the table." },
        { name: "server-tests", task: "Write the missing tests for src/server.ts in test/server.test.ts (GET /api/checks and the history route, incl. 404 and the limit param). Run them and report." },
      ],
    },
    { say: "Three agents are reviewing in parallel: API validation, SQLite query plans, and server tests. I'll put their reports together." },
  ],
  afterReports: () => [
    {
      say: `All three reports are in:

| Area | Result |
| --- | --- |
| **API validation** | \`?limit\` isn't bounded: \`limit=1e9\` reads the whole table. Clamp it to 1–1000 (\`src/server.ts:24\`). Ids are checked against the config, good. |
| **SQLite** | \`history()\` and \`uptime()\` use the \`(check_id, at)\` index. \`prune()\` scans the table: add an index on \`at\` (deletes go from 380 ms to 6 ms on 4.3M rows). |
| **Tests** | New \`test/server.test.ts\` with 5 cases (list, history, 404, limit, empty store); all 16 tests pass. |

Two small changes before tagging: clamp \`limit\` and add the \`at\` index. Want me to make them?`,
    },
  ],
};

const overlap: DemoScenario = {
  id: "overlap",
  agent: "pi",
  match: /^Now fix #3 too/,
  title: "Pre-1.0 audit with three reviewers",
  pace: "live",
  steps: (t) => [
    {
      think:
        "Replace the interval with a timer that's armed after each run finishes: a slow check then delays its next run instead of overlapping it. `stop()` has to clear whichever timer is pending, and a tick that finishes after `stop()` must not re-arm.",
    },
    { tools: [t.read("src/checks/scheduler.ts", { ms: 400 }), t.read("test/scheduler.test.ts", { ms: 520 })] },
    { say: "I'll schedule each run from the end of the previous one, and make sure `stop()` wins over a run that's still in flight." },
    {
      tools: [
        t.edit(
          "src/checks/scheduler.ts",
          [
            { oldText: "  private timers = new Map<string, NodeJS.Timeout>();", newText: "  private timers = new Map<string, NodeJS.Timeout>();\n  private stopped = false;" },
            {
              oldText: "    for (const check of this.checks) {\n      void this.tick(check);\n      this.timers.set(check.id, setInterval(() => void this.tick(check), check.intervalSec * 1000));\n    }",
              newText: "    this.stopped = false;\n    for (const check of this.checks) void this.loop(check);",
            },
            { oldText: "    for (const timer of this.timers.values()) clearInterval(timer);", newText: "    this.stopped = true;\n    for (const timer of this.timers.values()) clearTimeout(timer);" },
            {
              oldText: "  private async tick(check: CheckConfig): Promise<void> {",
              newText:
                "  /** Runs the check, then arms the next run: a slow check delays itself instead of overlapping. */\n  private async loop(check: CheckConfig): Promise<void> {\n    await this.tick(check).catch((err) => console.error(`lantern: ${check.id} failed:`, err));\n    if (!this.stopped) this.timers.set(check.id, setTimeout(() => void this.loop(check), check.intervalSec * 1000));\n  }\n\n  private async tick(check: CheckConfig): Promise<void> {",
            },
          ],
          700,
        ),
      ],
    },
    { tools: [t.sh("pnpm test", VITEST([["test/backoff.test.ts", 2, 3], ["test/http.test.ts", 5, 13], ["test/scheduler.test.ts", 1, 11]], "15:41:52"), 2400)] },
    {
      say: "Fixed #3: each check now arms its next run only after the current one finishes (`setTimeout` from the end of the run instead of `setInterval`), so a slow check pushes its own schedule back rather than running twice at once. `stop()` sets a flag first, so a run still in flight can't re-arm. Tests pass.",
    },
  ],
};

/**
 * The website's hero (`hero-story`): a question asked in a new chat. Short and calm: thinking, one
 * group of investigation (read, search, query plan), a one-line edit with its diff, a check, and a
 * short summary. Touches only `src/store.ts`, which no other live scenario edits.
 */
const prune: DemoScenario = {
  id: "prune",
  agent: "pi",
  match: /^Every hour the checks stall/,
  title: "Speed up pruning old results",
  titleMs: 1600,
  pace: "live",
  steps: (t) => [
    // Time to first token, while the sidebar shows the quick title, then the generated one.
    { pause: 1500 },
    {
      think:
        "Hourly matches the `setInterval` that calls `store.prune()`. A single `DELETE … WHERE at < ?` taking half a second smells like a full table scan: the only index I know of is `(check_id, at)`, which can't serve a range on `at` alone. Let me confirm with the schema and the query plan.",
    },
    { pause: 500 },
    {
      tools: [
        t.read("src/store.ts", { ms: 420 }),
        t.grep("prune", "src", "src/cli.ts:21:  setInterval(() => store.prune(), 3_600_000).unref();\nsrc/store.ts:52:  prune(): number {\n", 520),
        t.sh("sqlite3 lantern.db 'EXPLAIN QUERY PLAN DELETE FROM results WHERE at < 0'", "QUERY PLAN\n`--SCAN results\n", 1300),
      ],
    },
    {
      say: "Found it: `prune()` filters on `at` alone, but the only index starts with `check_id`, so SQLite scans every row (4.3M for a month of results) while holding the write lock. An index on `at` fixes that:",
    },
    {
      tools: [
        t.edit(
          "src/store.ts",
          [
            {
              oldText: "      CREATE INDEX IF NOT EXISTS results_check_at ON results (check_id, at);",
              newText: "      CREATE INDEX IF NOT EXISTS results_check_at ON results (check_id, at);\n      -- prune() deletes by age alone; without this it scans the whole table.\n      CREATE INDEX IF NOT EXISTS results_at ON results (at);",
            },
          ],
          450,
        ),
      ],
    },
    { say: "Timing the same delete again, then the tests:" },
    {
      tools: [
        t.sh("sqlite3 lantern.db '.timer on' 'DELETE FROM results WHERE at < strftime(\"%s\",\"now\",\"-30 days\")*1000'", "Run Time: real 0.006 user 0.002 sys 0.003\n", 900),
        t.sh("pnpm test", VITEST([["test/backoff.test.ts", 2, 3], ["test/http.test.ts", 5, 12], ["test/scheduler.test.ts", 1, 9]], "16:20:07"), 1500),
      ],
    },
    {
      say: "Fixed. The hourly cleanup was scanning the whole `results` table.\n\n- `src/store.ts`: a new index on `at`, created on startup with `IF NOT EXISTS`, so existing databases get it too.\n- Pruning a month of data: **380 ms → 6 ms**, so the checks no longer stall behind it.\n\nTests pass.",
    },
  ],
};

/** Asked out loud in the iPhone's conversation mode: a short spoken answer, no tools. */
const voice: DemoScenario = {
  id: "voice",
  agent: "pi",
  match: /^What's left before we tag 1\.0/i,
  title: "Pre-1.0 audit with three reviewers",
  pace: "live",
  steps: () => [
    { think: "Spoken question: answer in a few plain sentences, no tables or code." },
    {
      say: "Not much. The two issues that could make Lantern miss an alert are fixed, and the notifiers now time out after ten seconds. What's left is the scheduler overlap, which is a small change, and two accessibility touches on the dashboard: a label for the uptime chart and announcing status changes. I'd do the scheduler fix today and tag one point oh tomorrow morning.",
    },
  ],
};

export const DEMO_SCENARIOS: DemoScenario[] = [voice, retries, audit, auditFix, chartFlicker, region, discord, releaseNotes, percentiles, abortTimeout, jitter, review, overlap, prune];

// ---------------------------------------------------------------------------------------------
// Sub-agents
// ---------------------------------------------------------------------------------------------

export const DEMO_SUBAGENTS: DemoSubagentScript[] = [
  {
    name: "notifier-review",
    title: "Notifier error handling",
    pace: "history",
    minMs: 23_000,
    steps: (t) => [
      { tools: [t.read("src/notify/index.ts"), t.read("src/notify/slack.ts"), t.read("src/notify/webhook.ts")] },
      { think: "`Promise.all` rejects as soon as one target fails, and nothing catches it in `Scheduler.tick`, so the rejection escapes. Neither fetch has a timeout." },
      {
        report:
          "Two high-severity issues. (1) src/notify/index.ts:27 `Promise.all` — one failing target rejects the whole send; the rejection isn't caught in Scheduler.tick (src/checks/scheduler.ts:31), so other targets' errors are lost and the tick throws. Use Promise.allSettled and log per target. (2) src/notify/slack.ts:8 and src/notify/webhook.ts:6 — fetch has no timeout; a hanging endpoint stalls that check's tick. Add AbortSignal.timeout(10_000). Non-2xx answers are ignored silently (low).",
      },
    ],
  },
  {
    name: "scheduler-review",
    title: "Scheduler timers",
    pace: "history",
    minMs: 31_000,
    steps: (t) => [
      { tools: [t.read("src/checks/scheduler.ts"), t.read("test/scheduler.test.ts")] },
      { think: "setInterval fires regardless of whether the previous tick finished; with retries a slow check can take longer than its interval. lastOk is memory-only." },
      {
        report:
          "Medium: src/checks/scheduler.ts:19 setInterval doesn't wait for the previous tick, so a check slower than its interval (likely with retries) runs concurrently with itself and can record out-of-order results. Schedule the next run with setTimeout after each tick. Medium: lastOk (line 8) is in memory; a check that goes down during a restart never alerts because the first result only sets the baseline. Persist the last state or treat a failing first result as 'down'. Drift is fine (interval-based).",
      },
    ],
  },
  {
    name: "a11y-review",
    title: "Dashboard accessibility",
    pace: "history",
    minMs: 17_000,
    steps: (t) => [
      { tools: [t.read("web/src/App.tsx"), t.read("web/src/components/UptimeChart.tsx"), t.read("web/src/components/StatusBadge.tsx")] },
      {
        report:
          "Medium: web/src/components/UptimeChart.tsx:24 the SVG has no role or accessible name; screen readers skip it entirely. Add role=\"img\" and an aria-label with the uptime summary. Low: web/src/App.tsx:22 status and uptime update every 15 s with no aria-live region, so changes aren't announced. StatusBadge uses text labels, not colour alone: good.",
      },
    ],
  },
  {
    name: "docs",
    title: "Document retry options",
    pace: "live",
    steps: (t) => [
      { think: "The configuration table needs three rows, and a short section explaining why retries delay alerts." },
      { tools: [t.read("README.md", { ms: 700 })] },
      { pause: 500 },
      {
        tools: [
          t.edit(
            "README.md",
            [
              {
                oldText: "| `expectStatus`| 200–399 | Status codes that count as up             |",
                newText:
                  "| `expectStatus`| 200–399 | Status codes that count as up             |\n| `retries`     | 2       | Extra attempts before a check counts as down |\n| `retryDelayMs`| 500     | First retry delay; doubles on every attempt |\n| `retryJitter` | `equal` | `none`, `equal` or `full`: spreads retries of checks that fail together |\n\n### Flapping checks\n\nA check only counts as down after its retries fail too, so one slow response doesn't page anyone.\nThe cost is a later alert: up to `(retries + 1) × timeoutMs` plus the retry delays.",
              },
            ],
            1100,
          ),
        ],
      },
      { pause: 300 },
      { report: "README.md: added retries, retryDelayMs and retryJitter to the configuration table and a short 'Flapping checks' section on the alert-delay trade-off. No code touched." },
    ],
  },
  {
    name: "tests",
    title: "Jitter tests",
    pace: "live",
    steps: (t) => [
      { think: "Stub Math.random at 0 and 1 to pin the bounds of each mode." },
      { tools: [t.read("test/backoff.test.ts", { ms: 600 })] },
      { pause: 400 },
      {
        tools: [
          t.edit(
            "test/backoff.test.ts",
            [
              {
                oldText: 'import { describe, expect, it } from "vitest";',
                newText: 'import { afterEach, describe, expect, it, vi } from "vitest";',
              },
              {
                oldText: '  it("caps the delay", () => {\n    expect(backoffDelay(10, 500)).toBe(30_000);\n    expect(backoffDelay(3, 500, 2_000)).toBe(2_000);\n  });',
                newText:
                  '  afterEach(() => vi.restoreAllMocks());\n\n  it("caps the delay", () => {\n    expect(backoffDelay(10, 500, "none")).toBe(30_000);\n    expect(backoffDelay(3, 500, "none", 2_000)).toBe(2_000);\n  });\n\n  it("keeps equal jitter between half and the full delay", () => {\n    vi.spyOn(Math, "random").mockReturnValue(0);\n    expect(backoffDelay(1, 500, "equal")).toBe(500);\n    vi.spyOn(Math, "random").mockReturnValue(1);\n    expect(backoffDelay(1, 500, "equal")).toBe(1000);\n  });\n\n  it("lets full jitter go down to zero", () => {\n    vi.spyOn(Math, "random").mockReturnValue(0);\n    expect(backoffDelay(2, 500, "full")).toBe(0);\n  });\n\n  it("is exact without jitter", () => {\n    expect(backoffDelay(2, 500, "none")).toBe(2000);\n  });',
              },
            ],
            900,
          ),
        ],
      },
      { tools: [t.sh("pnpm test", VITEST([["test/backoff.test.ts", 5, 4], ["test/http.test.ts", 5, 13], ["test/scheduler.test.ts", 1, 9]], "15:20:33"), 1700)] },
      { report: "test/backoff.test.ts: 3 new cases (equal jitter within [d/2, d], full down to 0, none exact) with Math.random stubbed; existing cases pass jitter 'none'. All 11 tests pass." },
    ],
  },
  {
    name: "api-review",
    title: "API input validation",
    pace: "live",
    steps: (t) => [
      { think: "Two routes. The id is checked against the config; the limit query param goes straight into SQL." },
      { tools: [t.read("src/server.ts", { ms: 700 })] },
      { pause: 1200 },
      { tools: [t.grep("c.req.query", "src", "src/server.ts:24:    return c.json(store.history(id, Number(c.req.query(\"limit\") ?? 288)));\n", 600)] },
      { pause: 800 },
      { report: "src/server.ts:24 `limit` is unbounded and unchecked: limit=1e9 reads the whole table, limit=abc becomes NaN. Clamp to an integer in 1–1000 (default 288). The :id param is validated against the config (404), good." },
    ],
  },
  {
    name: "sqlite-perf",
    title: "SQLite query plans",
    pace: "live",
    steps: (t) => [
      { tools: [t.read("src/store.ts", { ms: 600 })] },
      { pause: 600 },
      {
        tools: [
          t.sh(
            "sqlite3 /tmp/lantern-bench.db 'EXPLAIN QUERY PLAN DELETE FROM results WHERE at < 0'",
            "QUERY PLAN\n`--SCAN results\n",
            1400,
          ),
        ],
      },
      { tools: [t.sh("sqlite3 /tmp/lantern-bench.db '.timer on' 'DELETE FROM results WHERE at < strftime(\"%s\",\"now\",\"-30 days\")*1000'", "Run Time: real 0.381 user 0.297 sys 0.081\n", 1700)] },
      { pause: 700 },
      { report: "history() and uptime() use results_check_at (SEARCH). prune() does a full SCAN: 380 ms per run on 4.3M rows (50 checks × 30 days). CREATE INDEX results_at ON results (at) brings it to 6 ms. Nothing else scans." },
    ],
  },
  {
    name: "server-tests",
    title: "Server tests",
    pace: "live",
    steps: (t) => [
      { tools: [t.read("src/server.ts", { ms: 500 }), t.read("test/http.test.ts", { ms: 650 })] },
      { pause: 900 },
      {
        tools: [
          t.write(
            "test/server.test.ts",
            `import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

const config = { port: 0, dbPath: ":memory:", notify: [], checks: [{ id: "api", name: "API", url: "https://api.test", intervalSec: 30, timeoutMs: 1000 }] };
const result = { checkId: "api", ok: true, status: 200, latencyMs: 41, at: 1 };
const store = { uptime: () => 0.999, history: (_id: string, limit: number) => Array(Math.min(limit, 3)).fill(result) };
const app = createServer(config, store as any);

describe("server", () => {
  it("lists checks with their uptime and last result", async () => {
    const body = await (await app.request("/api/checks")).json();
    expect(body).toEqual([expect.objectContaining({ id: "api", uptime24h: 0.999, last: result })]);
  });

  it("returns a check's history", async () => {
    expect(await (await app.request("/api/checks/api/history")).json()).toHaveLength(3);
  });

  it("honours the limit", async () => {
    expect(await (await app.request("/api/checks/api/history?limit=1")).json()).toHaveLength(1);
  });

  it("404s on unknown checks", async () => {
    expect((await app.request("/api/checks/nope/history")).status).toBe(404);
  });
});
`,
            900,
          ),
        ],
      },
      { tools: [t.sh("pnpm test", VITEST([["test/backoff.test.ts", 2, 3], ["test/http.test.ts", 5, 12], ["test/scheduler.test.ts", 1, 9], ["test/server.test.ts", 4, 18]], "16:02:11"), 2300)] },
      { report: "Added test/server.test.ts: list, history, limit and unknown-check 404 (plus the empty-store case inline). All 16 tests pass." },
    ],
  },
];

/** The scenario for a prompt (and agent), or null. */
export function findScenario(text: string, agent: DemoAgent["id"], scenarios = DEMO_SCENARIOS): DemoScenario | null {
  const prompt = text.trim();
  return scenarios.find((s) => (!s.agent || s.agent === agent) && s.match.test(prompt)) ?? null;
}

/** A believable reply to a prompt no scenario covers (never an echo). */
export function fallbackSteps(text: string, t: Tools): DemoStep[] {
  const ask = text.trim().split("\n")[0]!.slice(0, 120);
  return [
    { think: `The user asked: "${ask}". I'll check the project layout first so the answer refers to the right files.` },
    { tools: [t.ls(".", "README.md\nlantern.config.example.json\npackage.json\nsrc/\ntest/\ntsconfig.json\nweb/\n"), t.read("README.md")] },
    {
      say: "Lantern is small enough to change in one place for most requests: checks live in `src/checks/`, alerts in `src/notify/`, storage in `src/store.ts` and the dashboard in `web/src/`.\n\nTell me which part you want changed (or paste the error you're seeing) and I'll make the change and run the tests.",
    },
  ];
}

/** The scripted sub-agent spawned with `task` (titles for its tab), or null. */
export function subagentForTask(task: string): DemoSubagentScript | null {
  const t = toolsFor(DEMO_AGENTS.pi);
  for (const scenario of DEMO_SCENARIOS) {
    for (const step of scenario.steps(t)) {
      if (!("spawn" in step)) continue;
      const spawn = step.spawn.find((a) => a.task === task.trim());
      if (spawn) return DEMO_SUBAGENTS.find((s) => s.name === spawn.name) ?? null;
    }
  }
  return null;
}
