/**
 * I-198: agent versions and updates with fakes only: a fake version reader, fake fetch and a fake
 * shell (no `--version` runs, no network, no updater ever runs). Covers parsing/comparing, every
 * check state, the 10-minute reuse, update now / waiting for chats / cancel / failure, the log ring
 * buffer, and the routes (`/api/agent-versions*`, paired devices allowed).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentVersionsStatus, PairingInvite, PairResponse, SessionSummary } from "@glade/protocol";
import { AgentVersionsService, busyChatsOf, LOG_LINES, throttle, type AgentVersionsServiceOptions } from "../src/services/agent-versions/service.js";
import { compareVersions, parseVersion, readClaudeChannel, testingOverrides, type InstalledVersion } from "../src/services/agent-versions/versions.js";
import type { ShellRun } from "../src/services/update-job.js";
import { createApp } from "../src/http/app.js";
import { AuthService } from "../src/services/auth/auth-service.js";
import { createTestEnv } from "./helpers.js";

const NPM_PI = "https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest";
const NPM_CODEX = "https://registry.npmjs.org/@openai/codex/latest";
const CLAUDE_LATEST = "https://downloads.claude.ai/claude-code-releases/latest";
const CLAUDE_STABLE = "https://downloads.claude.ai/claude-code-releases/stable";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  vi.useRealTimers();
});

interface Fakes {
  installed: Record<string, InstalledVersion | Error>;
  remote: Record<string, string | Error>;
  busy: Record<string, number>;
  /** Exit code per command (default 0); `hold` commands wait for `release()`. */
  exits: Record<string, number>;
  hold: Set<string>;
  /** What a command does to the installed versions when it finishes (an updater). */
  effects: Record<string, () => void>;
}

function make(over: Partial<AgentVersionsServiceOptions> = {}, fakes: Partial<Fakes> = {}) {
  const f: Fakes = {
    installed: { pi: v("0.70.0"), claude: v("2.1.280"), codex: v("0.159.1") },
    remote: { [NPM_PI]: JSON.stringify({ version: "0.71.2" }), [CLAUDE_LATEST]: "2.1.293\n", [CLAUDE_STABLE]: "2.1.285\n", [NPM_CODEX]: JSON.stringify({ version: "0.159.1" }) },
    busy: {},
    exits: {},
    hold: new Set(),
    effects: {},
    ...fakes,
  };
  const fetched: string[] = [];
  const commands: { command: string; cwd: string }[] = [];
  const releases = new Map<string, () => void>();
  const pushes: AgentVersionsStatus[] = [];
  const updated: string[] = [];
  const shell: ShellRun = async (command, cwd, onOutput) => {
    commands.push({ command, cwd });
    onOutput(`running ${command}\n`);
    if (f.hold.has(command)) await new Promise<void>((resolve) => releases.set(command, resolve));
    f.effects[command]?.();
    onOutput("done");
    return f.exits[command] ?? 0;
  };
  const service = new AgentVersionsService({
    label: (id) => ({ pi: "pi", claude: "Claude Code", codex: "Codex" })[id] ?? id,
    busyChats: (h) => f.busy[h] ?? 0,
    readInstalled: async (h) => {
      const r = f.installed[h];
      if (r instanceof Error) throw r;
      return r ?? { installed: false };
    },
    fetchText: async (url) => {
      fetched.push(url);
      const r = f.remote[url];
      if (r instanceof Error) throw r;
      if (r === undefined) throw new Error("HTTP 404");
      return r;
    },
    claudeChannel: () => "latest",
    shell,
    cwd: "/home/me",
    onUpdated: (h) => void updated.push(h),
    onChange: (s) => pushes.push(s),
    waitTickMs: 60_000,
    ...over,
  });
  cleanups.push(() => service.dispose());
  const agent = (h: string, s = service.status()) => s.agents.find((a) => a.harness === h)!;
  return { service, f, fetched, commands, releases, pushes, updated, agent };
}

function v(version: string | null, output = version ?? "?"): InstalledVersion {
  return { installed: true, version, output };
}

describe("parseVersion / compareVersions", () => {
  it("takes the last x.y.z (pi may warn first) and ignores the words around it", () => {
    expect(parseVersion("Warning: Node 18.0.0 is old\n0.71.2\n")).toBe("0.71.2");
    expect(parseVersion("2.1.280 (Claude Code)")).toBe("2.1.280");
    expect(parseVersion("codex-cli 0.159.1")).toBe("0.159.1");
    expect(parseVersion("1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(parseVersion("no version")).toBeNull();
  });

  it("compares numerically, ignoring prereleases", () => {
    expect(compareVersions("2.1.280", "2.1.293")).toBeLessThan(0);
    expect(compareVersions("2.10.0", "2.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3-beta")).toBe(0);
    expect(compareVersions("0.159.1", "0.159.1")).toBe(0);
  });
});

describe("readClaudeChannel / testingOverrides / busyChatsOf", () => {
  it("reads autoUpdatesChannel; latest by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "glade-claude-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "settings.json");
    expect(readClaudeChannel(file)).toBe("latest");
    writeFileSync(file, JSON.stringify({ autoUpdatesChannel: "stable" }));
    expect(readClaudeChannel(file)).toBe("stable");
    writeFileSync(file, "{ not json");
    expect(readClaudeChannel(file)).toBe("latest");
  });

  it("reads per-agent testing overrides from the env", () => {
    const env = { GLADE_AGENT_UPDATE_COMMAND_CLAUDE: " echo hi ", GLADE_AGENT_VERSION_COMMAND_PI: "cat /tmp/v" };
    expect(testingOverrides("UPDATE", ["pi", "claude"], env)).toEqual({ claude: "echo hi" });
    expect(testingOverrides("VERSION", ["pi", "claude"], env)).toEqual({ pi: "cat /tmp/v" });
  });

  it("counts chats (workspaces) with the agent working or blocked on this server", () => {
    const s = (o: Partial<SessionSummary>) => ({ harness: "claude", status: "idle", workspaceId: "w1", ...o }) as SessionSummary;
    const list = [
      s({ status: "working" }),
      s({ status: "blocked", id: "sub" }),
      s({ status: "working", workspaceId: "w2" }),
      s({ status: "working", workspaceId: "w3", harness: "pi" }),
      s({ status: "working", workspaceId: "w4", activeElsewhere: { serverKind: "desktop" } as SessionSummary["activeElsewhere"] }),
      s({ status: "idle", workspaceId: "w5" }),
    ];
    expect(busyChatsOf(list, "claude")).toBe(2);
    expect(busyChatsOf(list, "pi")).toBe(1);
    expect(busyChatsOf(list, "codex")).toBe(0);
  });
});

describe("AgentVersionsService checks", () => {
  it("starts unknown, then reports behind / up-to-date with sources", async () => {
    const t = make();
    expect(t.service.status()).toMatchObject({ checking: false });
    expect(t.agent("claude")).toMatchObject({ state: "unknown", installed: null, latest: null, checkedAt: null, updateCommand: "claude update", update: null });
    const pending = t.service.check();
    expect(t.service.status().checking).toBe(true);
    const status = await pending;
    expect(status.checking).toBe(false);
    expect(t.agent("pi", status)).toMatchObject({ installed: "0.70.0", latest: "0.71.2", state: "behind", source: "npm", updateCommand: "pi update self" });
    expect(t.agent("claude", status)).toMatchObject({ installed: "2.1.280", latest: "2.1.293", state: "behind", source: "Claude Code latest channel" });
    expect(t.agent("codex", status)).toMatchObject({ installed: "0.159.1", latest: "0.159.1", state: "up-to-date", updateCommand: "codex update" });
    expect(t.agent("codex", status).checkedAt).toBeTruthy();
    expect(t.pushes.at(-1)).toEqual(status);
  });

  it("uses the stable channel when Claude Code follows it", async () => {
    const t = make({ claudeChannel: () => "stable" });
    const status = await t.service.check();
    expect(t.agent("claude", status)).toMatchObject({ latest: "2.1.285", source: "Claude Code stable channel", state: "behind" });
    expect(t.fetched).toContain(CLAUDE_STABLE);
    expect(t.fetched).not.toContain(CLAUDE_LATEST);
  });

  it("not installed, failed fetch, unreadable version, version command errors", async () => {
    const t = make(
      {},
      {
        installed: { pi: { installed: false }, claude: v(null, "Segmentation fault"), codex: new Error("spawn EACCES") },
        remote: { [NPM_PI]: new Error("fetch failed"), [CLAUDE_LATEST]: "<html>", [NPM_CODEX]: "{}" },
      },
    );
    const status = await t.service.check();
    expect(t.agent("pi", status)).toMatchObject({ state: "not-installed", installed: null });
    expect(t.agent("claude", status)).toMatchObject({ state: "failed", reason: '`claude --version` didn\'t print a version ("Segmentation fault").' });
    expect(t.agent("codex", status)).toMatchObject({ state: "failed", reason: "Couldn't run `codex --version` (spawn EACCES)." });
  });

  it("a failed latest-version fetch says why in a sentence", async () => {
    const t = make({}, { remote: { [NPM_PI]: new Error("fetch failed"), [CLAUDE_LATEST]: "<html>", [NPM_CODEX]: "{}" } });
    const status = await t.service.check();
    expect(t.agent("pi", status)).toMatchObject({ state: "failed", installed: "0.70.0", latest: null, reason: "Couldn't reach npm (fetch failed)." });
    expect(t.agent("claude", status)).toMatchObject({ state: "failed", reason: "Claude Code's release server gave an unexpected answer." });
    expect(t.agent("codex", status)).toMatchObject({ state: "failed", reason: "npm gave an unexpected answer for @openai/codex." });
  });

  it("reuses a check from the last 10 minutes unless forced; concurrent calls share one", async () => {
    let now = Date.parse("2026-10-05T10:00:00Z");
    const t = make({ now: () => new Date(now) });
    const [a, b] = [t.service.check(), t.service.check({ force: true })];
    expect(a).toBe(b);
    await a;
    expect(t.fetched).toHaveLength(3);
    now += 5 * 60_000;
    await t.service.check();
    expect(t.fetched).toHaveLength(3);
    await t.service.check({ force: true });
    expect(t.fetched).toHaveLength(6);
    now += 11 * 60_000;
    await t.service.check();
    expect(t.fetched).toHaveLength(9);
  });

  it("checks ~30 s after start, then daily", async () => {
    vi.useFakeTimers();
    const t = make({ startupDelayMs: 30_000, intervalMs: 24 * 3600_000 });
    t.service.start();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(t.fetched).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.fetched).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(t.fetched).toHaveLength(6);
    t.service.dispose();
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(t.fetched).toHaveLength(6);
  });
});

describe("AgentVersionsService updates", () => {
  it("runs the updater in the home folder, re-reads the version, reloads models, then done", async () => {
    const t = make();
    t.f.effects["claude update"] = () => (t.f.installed.claude = v("2.1.293"));
    await t.service.check();
    const started = t.service.startUpdate("claude");
    expect(t.agent("claude", started).update).toMatchObject({ state: "running", command: "claude update", from: "2.1.280" });
    await t.service.settled;
    expect(t.commands).toEqual([{ command: "claude update", cwd: "/home/me" }]);
    expect(t.updated).toEqual(["claude"]);
    const after = t.agent("claude");
    expect(after).toMatchObject({ installed: "2.1.293", state: "up-to-date" });
    expect(after.update).toMatchObject({ state: "done", from: "2.1.280", to: "2.1.293" });
    expect(after.update!.log).toEqual(["$ claude update", "running claude update", "done"]);
    expect(after.update!.startedAt).toBeTruthy();
    expect(after.update!.endedAt).toBeTruthy();
    // A new update may start after it's done.
    expect(() => t.service.startUpdate("claude")).not.toThrow();
  });

  it("an update before any check checks that agent afterwards (installed and newest)", async () => {
    const t = make();
    t.f.effects["claude update"] = () => (t.f.installed.claude = v("2.1.293"));
    t.service.startUpdate("claude");
    await t.service.settled;
    expect(t.agent("claude")).toMatchObject({ installed: "2.1.293", latest: "2.1.293", state: "up-to-date" });
    expect(t.agent("claude").update).toMatchObject({ state: "done", from: null, to: "2.1.293" });
    expect(t.agent("pi").state).toBe("unknown");
  });

  it("refuses unknown agents (404), a second run, a waiting one, and agents that aren't installed (409)", async () => {
    const t = make({}, { hold: new Set(["claude update"]), installed: { pi: { installed: false }, claude: v("2.1.280"), codex: v("0.159.1") } });
    await t.service.check();
    expect(() => t.service.startUpdate("gemini")).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => t.service.startUpdate("pi")).toThrow(expect.objectContaining({ status: 409, message: "pi isn't installed on this Mac." }));
    t.service.startUpdate("claude");
    expect(() => t.service.startUpdate("claude")).toThrow(expect.objectContaining({ status: 409, message: "Claude Code is already updating." }));
    expect(() => t.service.cancelUpdate("claude")).toThrow(expect.objectContaining({ status: 409 }));
    t.f.busy.codex = 1;
    t.service.startUpdate("codex");
    expect(() => t.service.startUpdate("codex")).toThrow(expect.objectContaining({ status: 409 }));
    t.releases.get("claude update")!();
    await t.service.settled;
  });

  it("waits for the agent's working chats, then starts when they're all idle", async () => {
    const t = make({}, { busy: { claude: 2 } });
    await t.service.check();
    const s = t.service.startUpdate("claude");
    expect(t.agent("claude", s).update).toMatchObject({ state: "waiting", waitingFor: 2 });
    expect(t.commands).toHaveLength(0);
    t.f.busy.claude = 1;
    t.service.sessionsChanged();
    expect(t.agent("claude").update).toMatchObject({ state: "waiting", waitingFor: 1 });
    t.f.busy.claude = 0;
    t.service.sessionsChanged();
    expect(t.agent("claude").update).toMatchObject({ state: "running" });
    expect(t.agent("claude").update!.waitingFor).toBeUndefined();
    await t.service.settled;
    expect(t.commands.map((c) => c.command)).toEqual(["claude update"]);
    expect(t.agent("claude").update!.state).toBe("done");
  });

  it("a waiting update also starts on the safety tick", async () => {
    vi.useFakeTimers();
    const t = make({ waitTickMs: 1000 }, { busy: { codex: 1 } });
    t.service.startUpdate("codex");
    t.f.busy.codex = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.commands.map((c) => c.command)).toEqual(["codex update"]);
  });

  it("cancel works only while waiting", async () => {
    const t = make({}, { busy: { pi: 1 } });
    t.service.startUpdate("pi");
    const s = t.service.cancelUpdate("pi");
    expect(t.agent("pi", s).update).toMatchObject({ state: "cancelled" });
    t.f.busy.pi = 0;
    t.service.sessionsChanged();
    expect(t.commands).toHaveLength(0);
    expect(() => t.service.cancelUpdate("pi")).toThrow(expect.objectContaining({ status: 409, message: "No update is waiting." }));
  });

  it("a non-zero exit fails with the log; models aren't reloaded", async () => {
    const t = make({}, { exits: { "pi update self": 1 } });
    t.service.startUpdate("pi");
    await t.service.settled;
    expect(t.agent("pi").update).toMatchObject({ state: "failed", error: "`pi update self` exited with code 1." });
    expect(t.agent("pi").update!.log).toContain("running pi update self");
    expect(t.updated).toEqual([]);
  });

  it("a shell that can't start fails with a sentence", async () => {
    const t = make({
      shell: async () => {
        throw new Error("spawn /bin/zsh ENOENT");
      },
    });
    t.service.startUpdate("codex");
    await t.service.settled;
    expect(t.agent("codex").update).toMatchObject({ state: "failed", error: "`codex update` couldn't start: spawn /bin/zsh ENOENT." });
  });

  it("keeps the last LOG_LINES lines and the last \\r redraw of each", async () => {
    const t = make({
      shell: async (_c, _cwd, onOutput) => {
        for (let i = 0; i < LOG_LINES + 50; i++) onOutput(`line ${i}\n`);
        onOutput("10%\r50%\r100%\n");
        return 0;
      },
    });
    t.service.startUpdate("pi");
    await t.service.settled;
    const log = t.agent("pi").update!.log;
    expect(log).toHaveLength(LOG_LINES);
    expect(log.at(-1)).toBe("100%");
    expect(log[0]).not.toBe("$ pi update self");
  });

  it("uses the testing override command and shows it", async () => {
    const t = make({ updateCommands: { claude: "echo fake" } });
    expect(t.agent("claude").updateCommand).toBe("echo fake");
    expect(t.agent("pi").updateCommand).toBe("pi update self");
    t.service.startUpdate("claude");
    await t.service.settled;
    expect(t.commands.map((c) => c.command)).toEqual(["echo fake"]);
  });

  it("throttle sends the first value at once and the last one later", () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const push = throttle((n: number) => sent.push(n), 250);
    push(1);
    push(2);
    push(3);
    expect(sent).toEqual([1]);
    vi.advanceTimersByTime(250);
    expect(sent).toEqual([1, 3]);
  });
});

describe("/api/agent-versions", () => {
  async function setup() {
    const env = createTestEnv();
    const t = make({}, { hold: new Set(["claude update"]) });
    const auth = new AuthService({
      db: env.store.db,
      environmentId: env.service.environment.id,
      environmentName: () => "Test Host",
      addresses: () => ["http://127.0.0.1:4317"],
      watchMs: 0,
      pairPollMs: 5,
      tailscaleLogin: async () => null,
    });
    const { app } = createApp({ service: env.service, auth, ownPorts: () => [4317], agentVersions: t.service });
    cleanups.push(async () => {
      auth.dispose();
      await env.cleanup();
    });
    const call = (method: string, path: string, o: { body?: unknown; token?: string; origin?: string } = {}) =>
      app.request(
        path,
        {
          method,
          headers: {
            host: "127.0.0.1:4317",
            ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
            ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
            ...(o.origin ? { origin: o.origin } : {}),
          },
          body: o.body === undefined ? undefined : JSON.stringify(o.body),
        },
        { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
      );
    const local = (method: string, path: string, body?: unknown) => call(method, path, { body });
    const remote = (method: string, path: string, token?: string) => call(method, path, { token, origin: "http://127.0.0.1:4400" });
    const pairDevice = async (): Promise<string> => {
      expect((await local("PATCH", "/api/auth/remote", { enabled: true })).status).toBe(200);
      const invite = (await (await local("POST", "/api/auth/invites")).json()) as PairingInvite;
      const grant = new URL(invite.link.replace("glade://", "http://x/")).searchParams.get("g")!;
      const res = call("POST", "/api/auth/pair", { body: { grant, deviceName: "iPhone", deviceKind: "phone" }, origin: "http://127.0.0.1:4400" });
      for (let i = 0; i < 400; i++) {
        const list = (await (await local("GET", "/api/auth/pending")).json()) as { id: string }[];
        if (list.length) {
          await local("POST", `/api/auth/pending/${list[0]!.id}`, { allow: true });
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      const body = (await (await res).json()) as PairResponse;
      if (body.status !== "paired") throw new Error(`not paired: ${JSON.stringify(body)}`);
      return body.token;
    };
    return { ...t, local, remote, pairDevice };
  }

  it("GET, check, update, cancel and their status codes", async () => {
    const t = await setup();
    const get = await t.local("GET", "/api/agent-versions");
    expect(get.status).toBe(200);
    expect(((await get.json()) as AgentVersionsStatus).agents.map((a) => a.harness)).toEqual(["pi", "claude", "codex"]);

    const check = (await (await t.local("POST", "/api/agent-versions/check")).json()) as AgentVersionsStatus;
    expect(t.agent("claude", check).state).toBe("behind");
    await t.local("POST", "/api/agent-versions/check");
    expect(t.fetched).toHaveLength(3);
    await t.local("POST", "/api/agent-versions/check?force=1");
    expect(t.fetched).toHaveLength(6);

    const up = await t.local("POST", "/api/agent-versions/claude/update");
    expect(up.status).toBe(200);
    expect(t.agent("claude", (await up.json()) as AgentVersionsStatus).update?.state).toBe("running");
    const again = await t.local("POST", "/api/agent-versions/claude/update");
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("Claude Code is already updating.");
    expect((await t.local("POST", "/api/agent-versions/claude/update/cancel")).status).toBe(409);
    expect((await t.local("POST", "/api/agent-versions/nope/update")).status).toBe(404);
    expect((await t.local("POST", "/api/agent-versions/nope/update/cancel")).status).toBe(404);

    t.f.busy.codex = 1;
    expect((await t.local("POST", "/api/agent-versions/codex/update")).status).toBe(200);
    const cancel = await t.local("POST", "/api/agent-versions/codex/update/cancel");
    expect(cancel.status).toBe(200);
    expect(t.agent("codex", (await cancel.json()) as AgentVersionsStatus).update?.state).toBe("cancelled");

    t.releases.get("claude update")!();
    await t.service.settled;
  });

  it("paired devices may read and start updates; unpaired ones may not", async () => {
    const t = await setup();
    const token = await t.pairDevice();
    expect((await t.remote("GET", "/api/agent-versions", token)).status).toBe(200);
    expect((await t.remote("POST", "/api/agent-versions/check", token)).status).toBe(200);
    expect((await t.remote("POST", "/api/agent-versions/pi/update", token)).status).toBe(200);
    expect((await t.remote("GET", "/api/agent-versions")).status).toBe(401);
    await t.service.settled;
  });
});
