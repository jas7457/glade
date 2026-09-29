/**
 * I-037: the agent API. Sub-agents spawned by a session run as `subagent` sessions of its
 * workspace; results and messages arrive as prompts; tokens identify callers.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_ENV, MAX_ACTIVE_AGENTS, type AgentEvent, type ListAgentsResponse, type SpawnAgentResponse } from "@glade/protocol";
import type { FakeSession } from "../src/harness/fake/fake-harness.js";
import { piChildEnv } from "../src/harness/pi/child-env.js";
import type { OpenSessionOptions } from "../src/harness/types.js";
import { createAgentsRoutes } from "../src/http/agents.js";
import { AgentRegistry } from "../src/services/agents.js";
import { HttpError } from "../src/services/app-service.js";
import { Store } from "../src/store/store.js";
import { createTestEnv, flush, newChat, until, type TestEnv } from "./helpers.js";

const URL_BASE = "http://127.0.0.1:4999";

let env: TestEnv;
/** Options of every agent process opened, in order. */
let opened: OpenSessionOptions[];

beforeEach(() => {
  env = createTestEnv();
  env.service.setServerUrl(URL_BASE);
  opened = [];
  const open = env.harness.openSession.bind(env.harness);
  env.harness.openSession = (options) => {
    opened.push(options);
    return open(options);
  };
  // Replies without tool calls: prompts just run and end.
  env.harness.script = () => [];
});
afterEach(async () => {
  await env.cleanup();
});

function fakeOf(sessionId: string): FakeSession {
  const ref = env.store.getSession(sessionId)!.sessionRef;
  return [...env.harness.openSessions].find((s) => s.sessionRef === ref)!;
}
const emit = (sessionId: string, ...events: AgentEvent[]) => events.forEach((e) => fakeOf(sessionId).emit(e));
/** The token the session's current process was started with. */
function tokenOf(sessionId: string): string {
  const options = opened.filter((o) => o.env?.[AGENT_ENV.sessionId] === sessionId).at(-1);
  return options!.env![AGENT_ENV.token]!;
}
const promptsTo = (sessionId: string) => fakeOf(sessionId).prompts;
const lastPrompt = (sessionId: string) => promptsTo(sessionId).at(-1);

async function settle(): Promise<void> {
  await flush();
  await env.service.settleAgentDeliveries();
  await flush();
}

async function spawn(parentId: string, name: string, extra: Record<string, unknown> = {}): Promise<SpawnAgentResponse> {
  const res = await env.service.spawnAgent(parentId, { name, task: `task for ${name}`, ...extra });
  await settle();
  return res;
}

describe("agent identity", () => {
  it("every agent process gets GLADE_URL (and the legacy PI_UI_URL), its session id and a fresh token", async () => {
    const chat = await newChat(env, { prompt: "hi" });
    const main = opened[0]!;
    expect(main.env).toMatchObject({ [AGENT_ENV.url]: URL_BASE, [AGENT_ENV.sessionId]: chat.sid });
    expect(main.env![AGENT_ENV.token]).toMatch(/^[\w-]{20,}$/);
    expect(main.env![AGENT_ENV.agentName]).toBeUndefined();
    expect(AGENT_ENV.url).toBe("GLADE_URL");
    expect(main.env).toMatchObject({
      PI_UI_URL: URL_BASE,
      PI_UI_SESSION_ID: chat.sid,
      PI_UI_TOKEN: main.env![AGENT_ENV.token],
    });
    expect(main.env!.PI_UI_AGENT_NAME).toBeUndefined();
    expect(main.appendSystemPrompt).toBeUndefined();
    expect(env.service.authenticateAgent(tokenOf(chat.sid)).id).toBe(chat.sid);
  });

  it("rejects unknown tokens and revokes a token when its process stops", async () => {
    const chat = await newChat(env);
    const token = tokenOf(chat.sid);
    expect(() => env.service.authenticateAgent("nope")).toThrow(HttpError);
    expect(() => env.service.authenticateAgent(undefined)).toThrow(HttpError);
    await env.service.createSession(chat.wid, {}); // second tab, so the first can be closed
    const tab = env.service.listSessions(chat.wid).find((s) => s.id !== chat.sid)!;
    const tabToken = tokenOf(tab.id);
    await env.service.deleteSession(tab.id);
    expect(() => env.service.authenticateAgent(tabToken)).toThrow(/Invalid agent token/);
    expect(env.service.authenticateAgent(token).id).toBe(chat.sid);
  });

  it("passes no identity until the server URL is known", async () => {
    const other = createTestEnv();
    const seen: OpenSessionOptions[] = [];
    const open = other.harness.openSession.bind(other.harness);
    other.harness.openSession = (o) => (seen.push(o), open(o));
    await other.service.createWorkspace({ projectId: null });
    expect(seen[0]!.env).toEqual({});
    await other.cleanup();
  });
});

describe("piChildEnv", () => {
  it("never inherits an agent identity, and adds the given one", () => {
    const out = piChildEnv(
      { PATH: "/bin", GLADE_URL: "u", GLADE_TOKEN: "t", GLADE_SESSION_ID: "s", GLADE_AGENT_NAME: "n", GLADE_DATA_DIR: "/d" },
      { GLADE_TOKEN: "mine" },
    );
    expect(out).toEqual({ PATH: "/bin", GLADE_DATA_DIR: "/d", GLADE_TOKEN: "mine" });
  });
});

describe("spawn", () => {
  it("starts a sub-agent session in the caller's workspace with its role and task", async () => {
    const chat = await newChat(env, { prompt: "orchestrate", model: { provider: "fake", id: "fast" }, thinkingLevel: "off" });
    await settle();
    const { agent } = await spawn(chat.sid, "Auth Scout", { agent: "scout", agentPrompt: "Be quick.", tools: ["read"] });

    expect(agent).toMatchObject({ name: "auth-scout", agent: "scout", task: "task for Auth Scout", result: null });
    const session = env.store.getSession(agent.sessionId)!;
    expect(session).toMatchObject({
      workspaceId: chat.wid,
      kind: "subagent",
      parentSessionId: chat.sid,
      agentName: "auth-scout",
      title: "Generated: task for Auth Scout", // I-148: a short title from its task
      titleSource: "auto",
      model: { provider: "fake", id: "fast" }, // inherited from the caller
      thinkingLevel: "off",
    });
    const options = opened.at(-1)!;
    expect(options.cwd).toBe(env.store.getWorkspace(chat.wid)!.cwd);
    expect(options.env).toMatchObject({ [AGENT_ENV.sessionId]: agent.sessionId, [AGENT_ENV.agentName]: "auth-scout" });
    expect(agent.displayName).toMatch(/^[A-Z]/);
    expect(agent.color).toBeTruthy();
    expect(options.appendSystemPrompt).toContain(`You are "auth-scout" (the user sees you as ${agent.displayName}), a sub-agent`);
    expect(options.appendSystemPrompt).toContain("## Agent role: scout\n\nBe quick.");
    expect(options.tools).toEqual(["read", "report_done", "message_agent"]);
    expect(promptsTo(agent.sessionId)[0]).toMatchObject({ text: "task for Auth Scout" });
    // Rolls up into the workspace like any session.
    expect(env.service.getWorkspaceDetail(chat.wid).sessions.map((s) => s.id)).toEqual([chat.sid, agent.sessionId]);
  });

  it("titles a sub-agent from its task only when Generate titles is on, and never over a rename (I-148)", async () => {
    const chat = await newChat(env, { prompt: "orchestrate" });
    await settle();
    env.service.updateSettings({ general: { generateTitles: false } });
    const off = await spawn(chat.sid, "plain");
    expect(env.store.getSession(off.agent.sessionId)).toMatchObject({ title: "plain", titleSource: "user" });

    env.service.updateSettings({ general: { generateTitles: true } });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const generate = env.harness.generateTitle.bind(env.harness);
    env.harness.generateTitle = async (options) => (await gate, generate(options));
    const renamed = await spawn(chat.sid, "renamed");
    await env.service.updateSession(renamed.agent.sessionId, { title: "Mine" });
    release();
    await settle();
    expect(env.store.getSession(renamed.agent.sessionId)).toMatchObject({ title: "Mine", titleSource: "user" });

    env.harness.generateTitle = async () => {
      throw new Error("model down");
    };
    const failed = await spawn(chat.sid, "failed");
    expect(env.store.getSession(failed.agent.sessionId)).toMatchObject({ title: "failed", titleSource: "user" });
  });

  it("resolves model names and validates thinking levels", async () => {
    const chat = await newChat(env);
    const { agent } = await spawn(chat.sid, "a", { model: "smart", thinking: "low" });
    expect(env.store.getSession(agent.sessionId)).toMatchObject({ model: { provider: "fake", id: "smart" }, thinkingLevel: "low" });
    const b = await spawn(chat.sid, "b", { model: "other/x-1" });
    expect(env.store.getSession(b.agent.sessionId)!.model).toEqual({ provider: "other", id: "x-1" });
    await expect(env.service.spawnAgent(chat.sid, { name: "c", task: "t", model: "nope" })).rejects.toThrow(/Unknown model/);
    await expect(env.service.spawnAgent(chat.sid, { name: "c", task: "t", thinking: "lots" })).rejects.toThrow(/thinking/);
  });

  it("guards: children can't spawn, names are unique, at most MAX_ACTIVE_AGENTS per workspace", async () => {
    const chat = await newChat(env);
    const { agent } = await spawn(chat.sid, "one");
    await expect(env.service.spawnAgent(agent.sessionId, { name: "x", task: "t" })).rejects.toMatchObject({ status: 403 });
    await expect(env.service.spawnAgent(chat.sid, { name: "ONE", task: "t" })).rejects.toMatchObject({ status: 409 });
    await expect(env.service.spawnAgent(chat.sid, { name: "main", task: "t" })).rejects.toMatchObject({ status: 400 });
    await expect(env.service.spawnAgent(chat.sid, { name: "k", task: "t", keepOpen: true })).rejects.toThrow(/keep_open_reason/);

    // A second main tab shares the workspace's budget.
    const tab = await env.service.createSession(chat.wid, {});
    for (let i = 2; i <= MAX_ACTIVE_AGENTS; i++) await spawn(i % 2 ? chat.sid : tab.session.id, `a${i}`);
    await expect(env.service.spawnAgent(chat.sid, { name: "extra", task: "t" })).rejects.toMatchObject({ status: 429 });

    // Closing one frees a slot and its name.
    await env.service.closeAgent(chat.sid, "one");
    await expect(spawn(chat.sid, "one")).resolves.toBeTruthy();
  });

  it("refuses spawns with 403 when 'Use sub-agents' is off (I-116)", async () => {
    const chat = await newChat(env);
    env.service.updateSettings({ agent: { subagents: false } });
    await expect(env.service.spawnAgent(chat.sid, { name: "x", task: "t" })).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/Use sub-agents/),
    });
    env.service.updateSettings({ agent: { subagents: true } });
    await expect(spawn(chat.sid, "x")).resolves.toBeTruthy();
  });

  it("persists records so a reopened sub-agent keeps its role", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glade-agents-"));
    try {
      const store = new Store(dir);
      const registry = new AgentRegistry(store);
      registry.upsert({
        sessionId: "s1", parentSessionId: "p", workspaceId: "w", name: "n", agent: null, task: "t", systemPrompt: "role",
        tools: null, autoClose: true, keepOpenReason: null, userEngaged: false, spawnedAt: 1, doneAt: null, result: null,
        closing: false, closed: false,
      });
      // Stored in glade.db (I-121): another store on the folder reads it back.
      const reopened = new Store(dir);
      expect(new AgentRegistry(reopened).get("s1")?.systemPrompt).toBe("role");
      store.dispose();
      reopened.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("report_done", () => {
  it("delivers the result to the parent as a follow-up and stops the sub-agent after its turn", async () => {
    const chat = await newChat(env);
    const { agent } = await spawn(chat.sid, "scout");
    emit(chat.sid, { type: "run_start" }, { type: "state", state: { isRunning: true } });
    emit(agent.sessionId, { type: "run_start" }, { type: "state", state: { isRunning: true } });

    expect(env.service.reportAgentDone(agent.sessionId, { summary: "Found it." })).toEqual({ closing: true });
    await settle();
    expect(lastPrompt(chat.sid)).toMatchObject({ text: `[agent-teams] ${agent.displayName} (scout) finished:\nFound it.`, behavior: "followUp" });

    // Still running its turn; stops at run_end.
    const token = tokenOf(agent.sessionId);
    expect(env.service.listAgents(chat.sid).agents[0]!.status).toBe("working");
    const ref = env.store.getSession(agent.sessionId)!.sessionRef!;
    const fake = fakeOf(agent.sessionId);
    const seen = env.messages.length;
    // pi sends run_end before state {isRunning:false}; the closing agent stops at run_end.
    fake.emit({ type: "run_end" });
    fake.emit({ type: "state", state: { isRunning: false } });
    // Clients are still told it stopped running (no tab stuck on "Working…").
    expect(env.messages.slice(seen)).toContainEqual(
      expect.objectContaining({ type: "session_event", sessionId: agent.sessionId, event: { type: "state", state: { isRunning: false } } }),
    );
    await until(() => env.service.listAgents(chat.sid).agents[0]!.status === "closed");
    expect(() => env.service.authenticateAgent(token)).toThrow();
    // I-055: its tab and conversation are deleted, like closing a cmux pane.
    await until(() => !env.store.getSession(agent.sessionId));
    expect(env.harness.sessions.has(ref)).toBe(false);
    expect(env.messages).toContainEqual({ type: "session_removed", sessionId: agent.sessionId, workspaceId: chat.wid });
    expect(env.service.listSessions(chat.wid).map((s) => s.id)).toEqual([chat.sid]);
    expect(env.service.listAgents(chat.sid).agents[0]).toMatchObject({ result: "Found it.", doneAt: expect.any(Number), tabOpen: false });
    // close_agent afterwards is not an error.
    expect(await env.service.closeAgent(chat.sid, "scout")).toEqual({ closed: true, alreadyClosed: true });
  });

  it("closes right away when it reports while idle", async () => {
    const chat = await newChat(env);
    const { agent } = await spawn(chat.sid, "quick");
    expect(env.service.reportAgentDone(agent.sessionId, { summary: "done" })).toEqual({ closing: true });
    await until(() => !env.store.getSession(agent.sessionId));
    expect(env.service.liveCount).toBe(1);
  });

  it("keeps it open when asked, and tells the parent what to do", async () => {
    const chat = await newChat(env);
    const { agent } = await spawn(chat.sid, "writer", { keepOpen: true, keepOpenReason: "apply review feedback" });
    expect(env.service.reportAgentDone(agent.sessionId, { summary: "Draft ready." })).toEqual({ closing: false });
    await settle();
    expect(lastPrompt(chat.sid)!.text).toContain(`(${agent.displayName} (writer) is still open — kept open for: apply review feedback.`);
    expect(env.service.listAgents(chat.sid).agents[0]!.status).toBe("done");
    expect(env.service.liveCount).toBe(2);
    // The browser sees it as done (I-054).
    expect(env.service.listSessions(chat.wid).find((s) => s.id === agent.sessionId)!.agent).toMatchObject({
      status: "done",
      result: "Draft ready.",
      keepOpenReason: "apply review feedback",
    });

    // close_agent closes its tab; again is fine.
    expect(await env.service.closeAgent(chat.sid, "writer")).toEqual({ closed: true });
    expect(env.store.getSession(agent.sessionId)).toBeUndefined();
    expect(await env.service.closeAgent(chat.sid, "writer")).toEqual({ closed: true, alreadyClosed: true });
    await expect(env.service.closeAgent(chat.sid, "nobody")).rejects.toMatchObject({ status: 404 });
  });

  it("never closes a sub-agent the user typed in", async () => {
    const chat = await newChat(env);
    const { agent } = await spawn(chat.sid, "helper");
    await env.service.prompt(agent.sessionId, { text: "also check tests" });
    await settle();
    expect(env.service.reportAgentDone(agent.sessionId, { summary: "ok" })).toEqual({ closing: false });
    await settle();
    expect(lastPrompt(chat.sid)!.text).toContain("stays open because the user has typed in it");
    expect(env.service.listAgents(chat.sid).agents[0]).toMatchObject({ userEngaged: true, status: "done", tabOpen: true });
    expect(env.store.getSession(agent.sessionId)).toBeTruthy();
  });

  it("is only for sub-agents", async () => {
    const chat = await newChat(env);
    expect(() => env.service.reportAgentDone(chat.sid, { summary: "x" })).toThrow(/Only sub-agents/);
  });
});

describe("messages, list and close", () => {
  it("routes messages between the parent and its sub-agents as steering prompts", async () => {
    const chat = await newChat(env);
    const a = (await spawn(chat.sid, "a")).agent;
    const b = (await spawn(chat.sid, "b")).agent;
    expect(opened.at(-1)!.appendSystemPrompt).toContain(`Other active sub-agents: ${a.displayName} (a).`);

    env.service.messageAgent(chat.sid, { to: "a", text: "focus on auth" });
    env.service.messageAgent(a.sessionId, { to: "main", text: "which branch?" });
    env.service.messageAgent(a.sessionId, { to: "b", text: "hello b" });
    await settle();
    expect(lastPrompt(a.sessionId)).toMatchObject({ text: "[agent-teams] message from main:\nfocus on auth", behavior: "steer" });
    expect(lastPrompt(chat.sid)).toMatchObject({ text: `[agent-teams] message from ${a.displayName} (a):\nwhich branch?` });
    expect(lastPrompt(b.sessionId)).toMatchObject({ text: `[agent-teams] message from ${a.displayName} (a):\nhello b` });

    expect(() => env.service.messageAgent(chat.sid, { to: "nobody", text: "x" })).toThrow(/No active agent/);
    expect(() => env.service.messageAgent(chat.sid, { to: "main", text: "x" })).toThrow(/main session/);
  });

  it("lists the team for the parent and for a sub-agent", async () => {
    const chat = await newChat(env);
    const a = (await spawn(chat.sid, "a")).agent;
    await spawn(chat.sid, "b");
    const forMain = env.service.listAgents(chat.sid);
    expect(forMain.self).toEqual({ sessionId: chat.sid, role: "main", name: null });
    expect(forMain.agents.map((x) => [x.name, x.status])).toEqual([["a", "idle"], ["b", "idle"]]);
    expect(env.service.listAgents(a.sessionId).self).toEqual({ sessionId: a.sessionId, role: "subagent", name: "a" });
    expect(env.service.listAgents(a.sessionId).agents).toHaveLength(2);
  });

  it("close_agent stops an idle sub-agent now and a running one after its turn", async () => {
    const chat = await newChat(env);
    const idle = (await spawn(chat.sid, "idle")).agent;
    const busy = (await spawn(chat.sid, "busy")).agent;
    expect(await env.service.closeAgent(chat.sid, "idle")).toEqual({ closed: true });
    expect(env.service.listAgents(chat.sid).agents.find((x) => x.name === "idle")).toMatchObject({ status: "closed", tabOpen: false });
    expect(env.store.getSession(idle.sessionId)).toBeUndefined();

    emit(busy.sessionId, { type: "run_start" });
    expect(await env.service.closeAgent(chat.sid, "busy")).toEqual({ closed: false });
    expect(env.service.listSessions(chat.wid).find((s) => s.id === busy.sessionId)!.agent).toMatchObject({ closing: true });
    emit(busy.sessionId, { type: "run_end" });
    await until(() => env.service.listAgents(chat.sid).agents.find((x) => x.name === "busy")!.status === "closed");
    await until(() => !env.store.getSession(busy.sessionId));
    expect(await env.service.closeAgent(chat.sid, "busy")).toEqual({ closed: true, alreadyClosed: true });
  });

  it("tells the parent when a sub-agent crashes or its tab is closed before reporting", async () => {
    const chat = await newChat(env);
    const a = (await spawn(chat.sid, "a")).agent;
    const b = (await spawn(chat.sid, "b")).agent;
    fakeOf(a.sessionId).crash("boom");
    await settle();
    expect(lastPrompt(chat.sid)!.text).toMatch(/^\[agent-teams\] (\S+ \()?a\)? exited:\nProcess ended without calling report_done \(crashed\)\.$/);
    expect(env.service.listAgents(chat.sid).agents.find((x) => x.name === "a")!.status).toBe("closed");

    await env.service.deleteSession(b.sessionId);
    await settle();
    expect(lastPrompt(chat.sid)!.text).toMatch(/\[agent-teams\] (\S+ \()?b\)? exited:\nExited before calling report_done \(the user closed its tab\)\./);
    expect(env.service.listAgents(chat.sid).agents.map((x) => [x.name, x.status, x.tabOpen])).toEqual([
      ["a", "closed", true], // crashed: its tab stays so the error is readable
      ["b", "closed", false],
    ]);
    expect(await env.service.closeAgent(chat.sid, "b")).toEqual({ closed: true, alreadyClosed: true });
  });

  it("shows a crashed sub-agent without restarting it until the user types", async () => {
    const chat = await newChat(env);
    const { agent } = await spawn(chat.sid, "a");
    fakeOf(agent.sessionId).crash("boom");
    await settle();
    const opens = opened.length;
    const detail = await env.service.getSessionDetail(agent.sessionId);
    expect(detail.session.agent).toMatchObject({ status: "closed" });
    expect(detail.transcript.messages.some((m) => m.role === "user")).toBe(true);
    expect(detail.state.isRunning).toBe(false);
    expect(await env.service.listCommands(agent.sessionId)).not.toHaveLength(0);
    expect(opened.length).toBe(opens);

    await env.service.prompt(agent.sessionId, { text: "try again" });
    expect(opened.length).toBe(opens + 1);
    expect(env.service.listSessions(chat.wid).find((s) => s.id === agent.sessionId)!.agent).toMatchObject({ userEngaged: true });
  });

  it("closing a crashed sub-agent removes its tab", async () => {
    const chat = await newChat(env);
    const { agent } = await spawn(chat.sid, "a");
    fakeOf(agent.sessionId).crash("boom");
    await settle();
    expect(await env.service.closeAgent(chat.sid, "a")).toEqual({ closed: true });
    expect(env.store.getSession(agent.sessionId)).toBeUndefined();
  });

  it("closing the parent's tab forgets its closed sub-agents too", async () => {
    const chat = await newChat(env);
    const tab = await env.service.createSession(chat.wid, {});
    const { agent } = await spawn(tab.session.id, "a");
    await env.service.closeAgent(tab.session.id, "a");
    expect(env.store.getSession(agent.sessionId)).toBeUndefined();
    await env.service.deleteSession(tab.session.id);
    await spawn(chat.sid, "b");
    expect(env.service.listAgents(chat.sid).agents.map((x) => x.name)).toEqual(["b"]);
  });

  it("a running session the server stops tells clients it stopped (no stuck Working…)", async () => {
    const chat = await newChat(env);
    const tab = await env.service.createSession(chat.wid, {});
    emit(tab.session.id, { type: "run_start" }, { type: "state", state: { isRunning: true } });
    const seen = env.messages.length;
    await env.service.deleteSession(tab.session.id);
    const events = env.messages
      .slice(seen)
      .flatMap((m) => (m.type === "session_event" && m.sessionId === tab.session.id ? [m.event] : []));
    expect(events).toEqual([{ type: "run_end" }, { type: "state", state: { isRunning: false } }]);
  });

  it("deleting the workspace forgets its agents", async () => {
    const chat = await newChat(env);
    await spawn(chat.sid, "a");
    const other = await newChat(env);
    await env.service.deleteWorkspace(chat.wid);
    expect(env.service.listAgents(other.sid).agents).toEqual([]);
  });
});

describe("HTTP routes", () => {
  const app = () => {
    const root = new Hono();
    root.route("/api/agents", createAgentsRoutes(env.service));
    return root;
  };
  const call = (path: string, token: string | null, body?: unknown) =>
    app().request(`http://127.0.0.1/api/agents${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("authenticates with the bearer token and serves the whole flow", async () => {
    const chat = await newChat(env);
    expect((await call("", null)).status).toBe(401);
    expect((await call("", "bogus")).status).toBe(401);

    const token = tokenOf(chat.sid);
    const spawned = await call("/spawn", token, { name: "scout", task: "look around" });
    expect(spawned.status).toBe(200);
    const { agent } = (await spawned.json()) as SpawnAgentResponse;
    await settle();

    const list = (await (await call("", token)).json()) as ListAgentsResponse;
    expect(list.agents.map((a) => a.name)).toEqual(["scout"]);

    const child = tokenOf(agent.sessionId);
    expect((await call("/spawn", child, { name: "x", task: "t" })).status).toBe(403);
    expect((await call("/message", child, { to: "main", text: "question" })).status).toBe(204);
    expect((await call("/message", token, { to: "ghost", text: "hi" })).status).toBe(404);
    expect((await call("/spawn", token, { name: "y" })).status).toBe(400);
    const done = await call("/report-done", child, { summary: "all good" });
    expect(await done.json()).toEqual({ closing: true });
    await settle();
    expect(agent.displayName).toBeTruthy(); // the spawn response names it (I-120)
    expect(list.agents[0]!.displayName).toBe(agent.displayName);
    expect(lastPrompt(chat.sid)!.text).toBe(`[agent-teams] ${agent.displayName} (scout) finished:\nall good`);
    const closed = await call("/close", token, { name: "scout" });
    expect(await closed.json()).toEqual({ closed: true, alreadyClosed: true });
    expect((await call("/close", token, { name: "ghost" })).status).toBe(404);
  });
});
