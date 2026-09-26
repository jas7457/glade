import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, CompactResult, NoticeMessage, SlashCommand } from "@pi-ui/protocol";
import { createApp } from "../src/http/app.js";
import { FAKE_COMMANDS, type FakeSession } from "../src/harness/fake/fake-harness.js";
import { compactionNoticeText, formatTokenCount } from "../src/harness/format.js";
import { PiSession } from "../src/harness/pi/pi-harness.js";
import type { PiRpcProcess } from "../src/harness/pi/rpc-process.js";
import { PiEventTranslator, translateCommands, translateMessages, translateSessionStats } from "../src/harness/pi/translate.js";
import { RevealUnavailableError } from "../src/services/reveal.js";
import { createTestEnv, flush, until, type TestEnv } from "./helpers.js";

// ---------------------------------------------------------------------------------------------
// Pure translation
// ---------------------------------------------------------------------------------------------

describe("formatTokenCount / compactionNoticeText", () => {
  it("formats compactly", () => {
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(42_130)).toBe("42.1k");
    expect(formatTokenCount(150_000)).toBe("150k");
    expect(formatTokenCount(1_234_000)).toBe("1.2M");
  });
  it("builds the compaction notice", () => {
    expect(compactionNoticeText(150_000, 32_000)).toBe("Compacted context: 150k → 32k tokens");
    expect(compactionNoticeText(150_000, null)).toBe("Compacted context (was 150k tokens)");
    expect(compactionNoticeText(null, null)).toBe("Context compacted");
  });
});

describe("translateSessionStats", () => {
  const data = {
    tokens: { input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000 },
    cost: 0.45,
    contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 },
  };
  it("maps context usage and totals", () => {
    expect(translateSessionStats(data)).toEqual({
      contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 },
      sessionStats: { tokens: data.tokens, cost: 0.45 },
    });
  });
  it("keeps null tokens after compaction and skips a missing context window", () => {
    expect(translateSessionStats({ ...data, contextUsage: { tokens: null, contextWindow: 200000, percent: null } }).contextUsage).toEqual({
      tokens: null,
      contextWindow: 200000,
      percent: null,
    });
    expect(translateSessionStats({ tokens: data.tokens, cost: 0 }).contextUsage).toBeUndefined();
    expect(translateSessionStats({}).sessionStats).toBeUndefined();
  });
});

describe("translateCommands", () => {
  it("maps get_commands, dropping junk and duplicates", () => {
    const commands = translateCommands({
      commands: [
        { name: "mcp", description: "Manage MCP servers", source: "extension", path: "/x.ts" },
        { name: "skill:web-design", description: "Design websites", source: "skill", location: "user" },
        { name: "fix-tests", description: "", source: "prompt" },
        { name: "mcp", source: "extension" },
        { name: "", source: "extension" },
        { name: "weird", source: "builtin" },
      ],
    });
    expect(commands).toEqual<SlashCommand[]>([
      { name: "mcp", description: "Manage MCP servers", source: "extension" },
      { name: "skill:web-design", description: "Design websites", source: "skill" },
      { name: "fix-tests", source: "prompt" },
    ]);
    expect(translateCommands({})).toEqual([]);
  });
});

describe("compaction notices", () => {
  it("compaction_end adds a transcript notice with the token drop", () => {
    const t = new PiEventTranslator();
    const events = t.translate({
      type: "compaction_end",
      reason: "manual",
      result: { summary: "…", tokensBefore: 150000, estimatedTokensAfter: 32000 },
      aborted: false,
    });
    expect(events[0]).toEqual({ type: "state", state: { isCompacting: false } });
    expect(events[1]).toMatchObject({ type: "message_end", message: { role: "notice", kind: "compaction", text: "Compacted context: 150k → 32k tokens" } });
    expect(t.translate({ type: "compaction_end", result: null, aborted: true })).toHaveLength(1);
    expect(t.translate({ type: "compaction_end", result: null, aborted: false, errorMessage: "Compaction failed: quota" })[1]).toEqual({
      type: "notify",
      level: "error",
      message: "Compaction failed: quota",
    });
  });
  it("history shows a short notice instead of the whole summary", () => {
    const t = translateMessages([{ role: "compactionSummary", summary: "long summary…", tokensBefore: 90000, timestamp: 1 }], (i) => `h${i}`);
    expect((t.messages[0] as NoticeMessage).text).toBe("Compacted context (was 90k tokens)");
  });
});

// ---------------------------------------------------------------------------------------------
// PiSession against a stub RPC process
// ---------------------------------------------------------------------------------------------

class StubProc extends EventEmitter {
  readonly calls: Array<Record<string, unknown>> = [];
  readonly waiting: Array<{ type: string; resolve: (d: unknown) => void }> = [];
  constructor(private readonly auto: Record<string, unknown> = {}) {
    super();
  }
  request(command: Record<string, unknown> & { type: string }, timeoutMs?: number): Promise<unknown> {
    this.calls.push({ ...command, ...(timeoutMs ? { timeoutMs } : {}) });
    if (command.type in this.auto) return Promise.resolve(this.auto[command.type]);
    return new Promise((resolve) => this.waiting.push({ type: command.type, resolve }));
  }
  count(type: string): number {
    return this.calls.filter((c) => c.type === type).length;
  }
}

const STATS = { tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 }, cost: 0.01, contextUsage: { tokens: 5000, contextWindow: 200000, percent: 2.5 } };

function stubSession(proc: StubProc, exportDir = "/exports") {
  return new PiSession(proc as unknown as PiRpcProcess, undefined, "/project", () => exportDir);
}

describe("PiSession", () => {
  it("refreshes stats after turns, at most one request in flight, coalescing the rest", async () => {
    const proc = new StubProc();
    const session = stubSession(proc);
    const events: AgentEvent[] = [];
    session.onEvent((e) => events.push(e));
    proc.emit("event", { type: "turn_end" });
    proc.emit("event", { type: "turn_end" });
    proc.emit("event", { type: "agent_settled" });
    expect(proc.count("get_session_stats")).toBe(1);
    proc.waiting.shift()!.resolve(STATS);
    await flush();
    // The coalesced follow-up.
    expect(proc.count("get_session_stats")).toBe(2);
    proc.waiting.shift()!.resolve({ ...STATS, contextUsage: { tokens: null, contextWindow: 200000, percent: null } });
    await flush();
    expect(proc.count("get_session_stats")).toBe(2);
    const states = events.filter((e) => e.type === "state" && e.state.contextUsage);
    expect(states).toHaveLength(2);
    expect(session.getState().contextUsage).toEqual({ tokens: null, contextWindow: 200000, percent: null });
    expect(session.getState().sessionStats?.cost).toBe(0.01);
    // Unrelated events don't trigger a refresh.
    proc.emit("event", { type: "message_update" });
    expect(proc.count("get_session_stats")).toBe(2);
  });

  it("lists commands once per process", async () => {
    const proc = new StubProc({ get_commands: { commands: [{ name: "mcp", source: "extension" }] } });
    const session = stubSession(proc);
    expect(await session.listCommands()).toEqual([{ name: "mcp", source: "extension" }]);
    await session.listCommands();
    expect(proc.count("get_commands")).toBe(1);
  });

  it("compacts with instructions and a long timeout", async () => {
    const proc = new StubProc({ compact: { summary: "s", tokensBefore: 150000, estimatedTokensAfter: 32000 } });
    const session = stubSession(proc);
    await expect(session.compact("  keep the API design  ")).resolves.toEqual<CompactResult>({ tokensBefore: 150000, tokensAfter: 32000 });
    expect(proc.calls.at(-1)).toEqual({ type: "compact", customInstructions: "keep the API design", timeoutMs: 300_000 });
    await session.compact();
    expect(proc.calls.at(-1)).toEqual({ type: "compact", timeoutMs: 300_000 });
  });

  it("doesn't toast a failed manual compaction (the request reports it)", async () => {
    const proc = new StubProc();
    const session = stubSession(proc);
    const events: AgentEvent[] = [];
    session.onEvent((e) => events.push(e));
    const pending = session.compact();
    proc.emit("event", { type: "compaction_end", result: null, aborted: false, errorMessage: "Nothing to compact" });
    proc.waiting.find((w) => w.type === "compact")!.resolve({ tokensBefore: 0 });
    await pending;
    expect(events.some((e) => e.type === "notify")).toBe(false);
    // Auto-compaction failures still toast.
    proc.emit("event", { type: "compaction_end", result: null, aborted: false, errorMessage: "quota" });
    expect(events.some((e) => e.type === "notify")).toBe(true);
  });

  it("exports HTML outside the project folder", async () => {
    const proc = new StubProc({ export_html: { path: "/exports/pi-session-x.html" } });
    const session = stubSession(proc);
    await expect(session.exportHtml()).resolves.toBe("/exports/pi-session-x.html");
    expect(String(proc.calls.at(-1)!.outputPath)).toMatch(/^\/exports\/pi-session-.*\.html$/);
  });
});

// ---------------------------------------------------------------------------------------------
// AppService + HTTP with the fake harness
// ---------------------------------------------------------------------------------------------

describe("slash-command endpoints", () => {
  let env: TestEnv;
  let app: ReturnType<typeof createApp>["app"];
  const revealPath = vi.fn(async (_path: string) => {});

  beforeEach(() => {
    revealPath.mockClear();
    env = createTestEnv({ revealPath });
    app = createApp({ service: env.service }).app;
  });
  afterEach(async () => {
    await env.cleanup();
  });

  const req = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { host: "127.0.0.1:4317", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  /** A new workspace; `chat.id` is its first session's id (what these endpoints take). */
  async function newChat(prompt?: string) {
    const created = await env.service.createWorkspace({ projectId: null, prompt });
    await flush();
    return { ...created.session, chat: created.session.session };
  }

  it("GET /commands returns the harness commands", async () => {
    const { chat } = await newChat();
    const res = await req("GET", `/api/sessions/${chat.id}/commands`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FAKE_COMMANDS);
    expect((await req("GET", "/api/sessions/nope/commands")).status).toBe(404);
  });

  it("chat detail and run_end carry context usage + session stats", async () => {
    const detail = await newChat();
    expect(detail.state.contextUsage).toMatchObject({ tokens: 0, contextWindow: 200000 });
    await env.service.prompt(detail.chat.id, { text: "hi" });
    await flush();
    const after = await env.service.getSessionDetail(detail.chat.id);
    expect(after.state.contextUsage?.tokens).toBeGreaterThan(0);
    expect(after.state.sessionStats?.cost).toBeGreaterThan(0);
  });

  it("POST /compact compacts, broadcasts the notice and resets usage to unknown", async () => {
    const { chat } = await newChat("hello");
    env.messages.length = 0;
    const res = await req("POST", `/api/sessions/${chat.id}/compact`, { instructions: "keep decisions" });
    expect(res.status).toBe(200);
    const result = (await res.json()) as CompactResult;
    expect(result.tokensBefore).toBeGreaterThan(0);
    const session = [...env.harness.openSessions][0] as FakeSession;
    expect(session.compactions).toEqual(["keep decisions"]);
    const events = env.messages.flatMap((m) => (m.type === "session_event" ? [m.event] : []));
    expect(events.some((e) => e.type === "message_end" && e.message.role === "notice" && e.message.kind === "compaction")).toBe(true);
    const detail = await env.service.getSessionDetail(chat.id);
    expect(detail.state.contextUsage?.tokens).toBeNull();
    expect(detail.transcript.messages.at(-1)).toMatchObject({ role: "notice", kind: "compaction" });
    // Empty body is fine too.
    expect((await req("POST", `/api/sessions/${chat.id}/compact`)).status).toBe(200);
  });

  it("refuses to compact while a reply is running", async () => {
    env.harness.eventDelayMs = 5;
    const { chat } = await newChat();
    await env.service.prompt(chat.id, { text: "slow" });
    await until(() => env.service.listSessions()[0]!.running);
    const res = await req("POST", `/api/sessions/${chat.id}/compact`, {});
    expect(res.status).toBe(409);
    await until(() => !env.service.listSessions()[0]!.running);
  });

  it("POST /export returns the path; /fs/reveal only reveals exported files", async () => {
    const { chat } = await newChat();
    const res = await req("POST", `/api/sessions/${chat.id}/export`);
    expect(res.status).toBe(200);
    const { path } = (await res.json()) as { path: string };
    expect(path).toMatch(/\.html$/);
    expect((await req("POST", `/api/sessions/${chat.id}/export`, { reveal: true })).status).toBe(200);
    expect(revealPath).toHaveBeenCalledWith(path);
    expect((await req("POST", "/api/fs/reveal", { path })).status).toBe(204);
    expect((await req("POST", "/api/fs/reveal", { path: "/etc/passwd" })).status).toBe(404);
    revealPath.mockRejectedValueOnce(new RevealUnavailableError("macOS only"));
    expect((await req("POST", "/api/fs/reveal", { path })).status).toBe(501);
  });
});
