/**
 * I-217 / I-218 (spawn side): sub-agents on another harness than their parent, and Glade agent
 * definitions applied at spawn (harness, model, thinking, prompt, tools, identity), with two fake
 * harnesses and a stubbed agent-defs service.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_ENV, emptyAgentDefFields, type AgentDef, type AgentDefFields, type AgentDefToolsResponse, type ModelInfo, type ServerMessage } from "@glade/protocol";
import { spawnAgentSpecFor } from "../src/harness/pi/extension/glade-tools.js";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import { createAgentsRoutes } from "../src/http/agents.js";
import { AgentDefsService, type AgentDefsListContext, type AgentDefsScope, type ResolvedAgentDef } from "../src/services/agent-defs/service.js";
import { pickAgentIdentity } from "../src/services/agent-names.js";
import { REPORT_REMINDER } from "../src/services/agents.js";
import { isReadOnlyAgent, spawnableAgent } from "../src/services/app/agent-team.js";
import { AppService, HttpError } from "../src/services/app-service.js";
import { Store } from "../src/store/store.js";
import { flush, until } from "./helpers.js";

const OTHER_MODELS: ModelInfo[] = [
  { provider: "other", id: "big", name: "Other Big", thinkingLevels: ["low", "medium", "high"], input: ["text"], contextWindow: 100_000 },
  { provider: "other", id: "tiny", name: "Other Tiny", thinkingLevels: ["off"], input: ["text"], contextWindow: 10_000 },
];

/** A definition as the agent-defs service would resolve it. */
function def(fields: Partial<AgentDefFields> & { name: string }, native: ResolvedAgentDef["native"] = {}): ResolvedAgentDef {
  const all = { ...emptyAgentDefFields(), description: `${fields.name} agent`, ...fields };
  const agentDef: AgentDef = {
    id: `personal:${all.name}`,
    source: "personal",
    path: `~/agents/${all.name}.md`,
    editable: true,
    fields: all,
    effective: all,
    base: null,
    enabled: true,
    available: true,
    problems: [],
    customizes: null,
    customizedBy: null,
  };
  return { def: agentDef, native };
}

/** Stub of the agent-defs service: a fixed set of definitions, recorded tools in memory. */
class StubDefs extends AgentDefsService {
  defs = new Map<string, ResolvedAgentDef>();
  seen = new Map<string, AgentDefToolsResponse>();
  lists: Array<{ scope: AgentDefsScope; ctx: AgentDefsListContext }> = [];
  constructor() {
    super({ dataDir: tmpdir() });
  }
  override async list(scope: AgentDefsScope, ctx: AgentDefsListContext): Promise<AgentDef[]> {
    this.lists.push({ scope, ctx });
    return [...this.defs.values()].map((d) => d.def);
  }
  override async resolve(name: string): Promise<ResolvedAgentDef> {
    const found = this.defs.get(name);
    if (!found) throw new HttpError(400, `Unknown agent "${name}". Available agents: ${[...this.defs.keys()].join(", ")}.`);
    return found;
  }
  override recordTools(harness: string, projectId: string | null, tools: string[], mcpServers: string[]): void {
    this.seen.set(`${harness}:${projectId}`, { harness, tools, mcpServers, seenAt: Date.now() });
  }
  override tools(harness: string, projectId: string | null): AgentDefToolsResponse {
    return this.seen.get(`${harness}:${projectId}`) ?? { harness, tools: [], mcpServers: [], seenAt: null };
  }
}

let dir: string;
let store: Store;
let main: FakeHarness;
let other: FakeHarness;
let defs: StubDefs;
let service: AppService;
let messages: ServerMessage[];
let offline: Set<string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "glade-xh-"));
  store = new Store(join(dir, "data"), 0);
  main = new FakeHarness(() => [], 0);
  other = new FakeHarness(() => [], 0, { id: "other", label: "Other Agent", models: OTHER_MODELS, capabilities: { subagents: true } });
  offline = new Set();
  defs = new StubDefs();
  const registry = new HarnessRegistry([main, other], { enabled: (id) => !offline.has(id) });
  service = new AppService({ store, harnesses: registry, scratchDir: join(dir, "scratch"), agentDefs: defs });
  service.setServerUrl("http://127.0.0.1:4999");
  service.updateSettings({ agent: { subagentOtherHarnesses: true, subagentOtherModels: true } }); // I-221: off by default
  messages = [];
  service.subscribe((m) => messages.push(m));
});
afterEach(async () => {
  await service.dispose();
  rmSync(dir, { recursive: true, force: true });
});

async function parent() {
  const res = await service.createWorkspace({ projectId: null, prompt: "orchestrate", model: { provider: "fake", id: "smart" }, thinkingLevel: "high" });
  await flush();
  return res.session.session.id;
}

async function settle(): Promise<void> {
  await flush();
  await service.settleAgentDeliveries();
  await flush();
}

const fakeOf = (harness: FakeHarness, sessionId: string) => {
  const ref = store.getSession(sessionId)!.sessionRef;
  return [...harness.openSessions].find((s) => s.sessionRef === ref)!;
};

describe("sub-agents on another harness (I-217)", () => {
  it("runs on the requested harness with that harness's model rules", async () => {
    const sid = await parent();
    const { agent } = await service.spawnAgent(sid, { name: "x", task: "look", harness: "other" });
    const child = store.getSession(agent.sessionId)!;
    expect(child.harness).toBe("other");
    expect(agent.harness).toBe("other");
    // Not the parent's model (another harness): the new session's default (the harness picks).
    expect(child.model).toEqual({ provider: "other", id: "big" });
    expect(other.opened.at(-1)!.env![AGENT_ENV.agentName]).toBe("x");
    expect(main.opened.some((o) => o.env?.[AGENT_ENV.sessionId] === agent.sessionId)).toBe(false);
  });

  it("model: the definition's when listed → that harness's sub-agent setting → its default; thinking clamped", async () => {
    const sid = await parent();
    defs.defs.set("tiny", def({ name: "tiny", harness: "other", model: "other/tiny", thinking: "high" }));
    let { agent } = await service.spawnAgent(sid, { name: "a", task: "t", agent: "tiny" });
    expect(store.getSession(agent.sessionId)).toMatchObject({ harness: "other", model: { provider: "other", id: "tiny" }, thinkingLevel: "off" });

    // A model the harness doesn't list: the harness's sub-agent setting (never the parent's).
    service.updateSettings({ models: { agents: { other: { subagentModel: { provider: "other", id: "big" }, subagentThinkingLevel: "medium" } } } });
    defs.defs.set("bad", def({ name: "bad", harness: "other", model: "fake/smart" }));
    ({ agent } = await service.spawnAgent(sid, { name: "b", task: "t", agent: "bad" }));
    expect(store.getSession(agent.sessionId)).toMatchObject({ model: { provider: "other", id: "big" }, thinkingLevel: "medium" });

    // A bare id is matched within the harness.
    defs.defs.set("bare", def({ name: "bare", harness: "other", model: "tiny" }));
    ({ agent } = await service.spawnAgent(sid, { name: "c", task: "t", agent: "bare" }));
    expect(store.getSession(agent.sessionId)!.model).toEqual({ provider: "other", id: "tiny" });
  });

  it("inherit: the parent's harness and model; the request's harness beats the definition's", async () => {
    const sid = await parent();
    defs.defs.set("plain", def({ name: "plain" }));
    let { agent } = await service.spawnAgent(sid, { name: "a", task: "t", agent: "plain" });
    expect(store.getSession(agent.sessionId)).toMatchObject({ harness: "fake", model: { provider: "fake", id: "smart" }, thinkingLevel: "high" });
    defs.defs.set("elsewhere", def({ name: "elsewhere", harness: "other" }));
    ({ agent } = await service.spawnAgent(sid, { name: "b", task: "t", agent: "elsewhere", harness: "fake" }));
    expect(store.getSession(agent.sessionId)!.harness).toBe("fake");
    ({ agent } = await service.spawnAgent(sid, { name: "c", task: "t", agent: "elsewhere", harness: "inherit" }));
    expect(store.getSession(agent.sessionId)!.harness).toBe("other");
  });

  it("a harness this device doesn't offer (or doesn't know) is a clear 400", async () => {
    const sid = await parent();
    offline.add("other");
    await expect(service.spawnAgent(sid, { name: "x", task: "t", harness: "other" })).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/^Other Agent isn't available on .* \(turned off or not installed\), so the sub-agent can't start on it\./),
    });
    defs.defs.set("o", def({ name: "o", harness: "other" }));
    await expect(service.spawnAgent(sid, { name: "x", task: "t", agent: "o" })).rejects.toThrow(/so the agent "o" can't start on it/);
    await expect(service.spawnAgent(sid, { name: "x", task: "t", harness: "nope" })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/no agent harness "nope"/) });
    // A harness that can't run Glade's sub-agent tools.
    offline.delete("other");
    (other.info.capabilities as { subagents: boolean }).subagents = false;
    await expect(service.spawnAgent(sid, { name: "x", task: "t", harness: "other" })).rejects.toThrow(/can't run Glade sub-agents/);
    expect(store.listSessions().filter((s) => s.kind === "subagent")).toEqual([]);
  });

  it("messages, steering, report_done and close work across harnesses", async () => {
    const sid = await parent();
    const { agent } = await service.spawnAgent(sid, { name: "x", task: "look", harness: "other" });
    await settle();
    const child = fakeOf(other, agent.sessionId);
    expect(child.prompts[0]!.text).toBe("look");
    service.messageAgent(sid, { to: "x", text: "also check y" });
    await settle();
    expect(child.prompts.at(-1)).toMatchObject({ text: expect.stringContaining("also check y"), behavior: "steer" });
    service.messageAgent(agent.sessionId, { to: "main", text: "question" });
    await settle();
    const parentFake = fakeOf(main, sid);
    expect(parentFake.prompts.at(-1)!.text).toContain("question");
    expect(service.reportAgentDone(agent.sessionId, { summary: "Found it." })).toEqual({ closing: true });
    await settle();
    expect(parentFake.prompts.at(-1)!.text).toMatch(/finished:[\s\S]*Found it\./);
    await until(() => !store.getSession(agent.sessionId));
    expect(service.listAgents(sid).agents[0]).toMatchObject({ name: "x", harness: "other", status: "closed", tabOpen: false });
  });

  it("a crashed child on another harness is restarted on its own harness when typed in", async () => {
    const sid = await parent();
    const { agent } = await service.spawnAgent(sid, { name: "x", task: "look", harness: "other" });
    await settle();
    fakeOf(other, agent.sessionId).crash("boom");
    await settle();
    expect(fakeOf(main, sid).prompts.at(-1)!.text).toMatch(/exited/);
    const before = other.opened.length;
    await service.prompt(agent.sessionId, { text: "continue" });
    await settle();
    expect(other.opened.length).toBe(before + 1);
    expect(other.opened.at(-1)!.env![AGENT_ENV.agentName]).toBe("x");
  });
});

describe("agent definitions at spawn (I-218)", () => {
  it("passes the definition, its prompt and tools to the child's harness; identity from the definition", async () => {
    const sid = await parent();
    defs.defs.set(
      "scout",
      def({ name: "scout", harness: "other", nicknames: ["Brandon"], color: "teal", icon: "search", tools: ["Read", "Grep"], permissionMode: "plan", prompt: "Cite file:line." }, { claude: { maxTurns: 3 } }),
    );
    const { agent } = await service.spawnAgent(sid, { name: "auth-scout", task: "find auth", agent: "scout" });
    expect(agent).toMatchObject({ name: "auth-scout", displayName: "Brandon", color: "teal", icon: "search", harness: "other", agent: "scout" });
    const opened = other.opened.at(-1)!;
    expect(opened.appendSystemPrompt).toMatch(/## Agent role: scout\n\nCite file:line\./);
    expect(opened.tools).toEqual(["Read", "Grep", "report_done", "message_agent"]);
    expect(opened.agentDefinition).toMatchObject({
      name: "scout",
      prompt: "Cite file:line.",
      tools: ["Read", "Grep"],
      permissionMode: "plan",
      native: { claude: { maxTurns: 3 } },
    });
    expect(opened.agentDefinition!.rolePrompt).not.toContain("Cite file:line");
    expect(opened.agentDefinition!.rolePrompt).toContain('You are "auth-scout" (the user sees you as Brandon)');
    const session = store.getSession(agent.sessionId)!;
    expect(session).toMatchObject({ agentDisplayName: "Brandon", agentColor: "teal", agentIcon: "search" });
    const parentSummary = service.listSessions().find((s) => s.id === sid)!;
    expect(parentSummary.spawnedAgents?.[0]).toMatchObject({ name: "auth-scout", displayName: "Brandon", icon: "search", agent: "scout", harness: "other" });
    // Reopened later: the definition is applied again.
    await settle();
    fakeOf(other, agent.sessionId).crash("boom");
    await settle();
    await service.prompt(agent.sessionId, { text: "go on" });
    expect(other.opened.at(-1)!.agentDefinition).toMatchObject({ name: "scout" });
  });

  it("nicknames: the first free one, then numbered", async () => {
    const sid = await parent();
    defs.defs.set("scout", def({ name: "scout", nicknames: ["Brandon", "Bea"] }));
    const names: string[] = [];
    for (const n of ["a", "b", "c", "d"]) names.push((await service.spawnAgent(sid, { name: n, task: "t", agent: "scout" })).agent.displayName!);
    expect(names).toEqual(["Brandon", "Bea", "Brandon 2", "Brandon 3"]);
  });

  it("unknown agents are refused with the service's message; older agent-teams requests still work", async () => {
    const sid = await parent();
    defs.defs.set("scout", def({ name: "scout" }));
    await expect(service.spawnAgent(sid, { name: "x", task: "t", agent: "nope" })).rejects.toMatchObject({ status: 400, message: 'Unknown agent "nope". Available agents: scout.' });
    const { agent } = await service.spawnAgent(sid, { name: "y", task: "t", agent: "worker", agentPrompt: "Work hard.", tools: ["read"], thinking: "low" });
    expect(agent.agent).toBe("worker");
    const opened = main.opened.at(-1)!;
    expect(opened.appendSystemPrompt).toMatch(/## Agent role: worker\n\nWork hard\./);
    expect(opened.tools).toEqual(["read", "report_done", "message_agent"]);
    expect(opened.agentDefinition).toBeUndefined();
    expect(store.getSession(agent.sessionId)!.thinkingLevel).toBe("low");
  });

  it("pi-like harnesses: tools the harness last reported not having are refused", async () => {
    // `pi` is the strict harness (unknown --tools names are ignored silently).
    const pi = new FakeHarness(() => [], 0, { id: "pi", capabilities: { subagents: true } });
    await service.dispose();
    defs = new StubDefs();
    store = new Store(join(dir, "data2"), 0);
    service = new AppService({ store, harnesses: new HarnessRegistry([pi]), scratchDir: join(dir, "scratch"), agentDefs: defs });
    const res = await service.createWorkspace({ projectId: null, prompt: "hi" });
    const sid = res.session.session.id;
    defs.defs.set("lint", def({ name: "lint", tools: ["read", "eslint"] }));
    // Never reported: not checked.
    await service.spawnAgent(sid, { name: "a", task: "t", agent: "lint" });
    service.recordAgentTools(sid, ["read", "bash", "spawn_agent"], []);
    expect(defs.tools("pi", null).tools).toEqual(["read", "bash"]);
    await expect(service.spawnAgent(sid, { name: "b", task: "t", agent: "lint" })).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/^Can't spawn "lint": Fake agent doesn't have the tools eslint\./),
    });
  });
});

describe("spawn_agent's agent list and tool reports (I-218)", () => {
  it("lists enabled, available agents (not a customized source) with harness label, model and read-only", async () => {
    const sid = await parent();
    defs.defs.set("scout", def({ name: "scout", harness: "other", model: "other/tiny", tools: ["Read", "Grep"] }));
    defs.defs.set("writer", def({ name: "writer" }));
    const off = def({ name: "off" });
    off.def.enabled = false;
    defs.defs.set("off", off);
    const superseded = def({ name: "pi-scout" });
    superseded.def.customizedBy = "personal:pi-scout";
    defs.defs.set("pi-scout", superseded);
    const list = await service.spawnableAgents(sid);
    expect(list.agents).toEqual([
      { name: "scout", description: "scout agent", harness: "other", harnessLabel: "Other Agent", model: "tiny", readOnly: true },
      { name: "writer", description: "writer agent", harness: null, harnessLabel: null, model: null, readOnly: false },
    ]);
    expect(list.harnesses).toEqual([
      { id: "fake", label: "Fake agent" },
      { id: "other", label: "Other Agent" },
    ]);
    expect(defs.lists.at(-1)!.ctx.offeredHarnesses).toEqual(["fake", "other"]);
  });

  it("main sessions get the list and a tool reporter; sub-agents don't", async () => {
    defs.defs.set("writer", def({ name: "writer" }));
    const sid = await parent();
    const opened = main.opened[0]!;
    expect((await opened.spawnableAgents!()).agents.map((a) => a.name)).toEqual(["writer"]);
    opened.onTools!(["Read", "mcp__glade__spawn_agent", "mcp__docs__search"], ["glade", "docs"]);
    expect(defs.tools("fake", null)).toMatchObject({ tools: ["Read", "mcp__docs__search"], mcpServers: ["docs"] });
    await service.spawnAgent(sid, { name: "x", task: "t" });
    expect(main.opened.at(-1)!.spawnableAgents).toBeUndefined();
    expect(main.opened.at(-1)!.onTools).toBeUndefined();
  });

  it("read-only per harness", () => {
    const f = (fields: Partial<AgentDefFields>) => isReadOnlyAgent({ ...emptyAgentDefFields(), ...fields });
    expect(f({ sandbox: "read-only" })).toBe(true);
    expect(f({ sandbox: "workspace-write" })).toBe(false);
    expect(f({ permissionMode: "plan" })).toBe(true);
    expect(f({ tools: ["read", "grep"] })).toBe(true);
    expect(f({ tools: ["read", "bash"] })).toBe(false);
    expect(f({ tools: ["Read", "Edit"] })).toBe(false);
    expect(f({ disallowedTools: ["Write", "Edit", "Bash"] })).toBe(true);
    expect(f({})).toBe(false);
    expect(spawnableAgent({ ...emptyAgentDefFields("codex"), name: "o", model: "codex/gpt-5.4-mini", sandbox: "read-only" }, () => "Codex")).toMatchObject({
      harnessLabel: "Codex",
      model: "gpt-5.4-mini",
      readOnly: true,
    });
  });

  it("HTTP: GET /definitions and POST /tools with the session's token", async () => {
    defs.defs.set("writer", def({ name: "writer" }));
    const sid = await parent();
    const token = main.opened[0]!.env![AGENT_ENV.token]!;
    const root = new Hono();
    root.route("/api/agents", createAgentsRoutes(service));
    const call = (path: string, body?: unknown) =>
      root.request(`http://127.0.0.1/api/agents${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const res = await call("/definitions");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agents: Array<{ name: string }> }).agents.map((a) => a.name)).toEqual(["writer"]);
    expect((await call("/tools", { tools: ["read", "report_done"], mcpServers: [] })).status).toBe(204);
    expect(defs.tools("fake", null).tools).toEqual(["read"]);
    expect((await call("/tools", { tools: "read" })).status).toBe(400);
    expect(sid).toBeTruthy();
  });
});

describe("report_done reminder", () => {
  const reminders = (harness: FakeHarness, sessionId: string) => fakeOf(harness, sessionId).prompts.filter((p) => p.text === REPORT_REMINDER);
  // Turns end a little after their prompt (as with real agents), not inside the delivery.
  beforeEach(() => {
    other.eventDelayMs = 1;
  });

  it("a turn that ends without report_done gets one follow-up reminder, not two", async () => {
    const sid = await parent();
    const { agent } = await service.spawnAgent(sid, { name: "x", task: "look", harness: "other" });
    await settle();
    await until(() => reminders(other, agent.sessionId).length === 1);
    expect(reminders(other, agent.sessionId)[0]!.behavior).toBe("followUp");
    // The reminded turn ended without reporting too: no second reminder.
    await settle();
    await flush(20);
    expect(reminders(other, agent.sessionId)).toHaveLength(1);
    // New work from main: it may be reminded again.
    service.messageAgent(sid, { to: "x", text: "one more thing" });
    await settle();
    await until(() => reminders(other, agent.sessionId).length === 2);
  });

  it("not after report_done, not when the user typed in it, not after a stopped turn", async () => {
    const sid = await parent();
    // Reports during its first turn.
    other.script = () => [];
    const reported = await service.spawnAgent(sid, { name: "r", task: "t", harness: "other", keepOpen: true, keepOpenReason: "follow-up" });
    service.reportAgentDone(reported.agent.sessionId, { summary: "done" });
    await settle();
    await flush(20);
    expect(reminders(other, reported.agent.sessionId)).toEqual([]);

    const engaged = await service.spawnAgent(sid, { name: "u", task: "t", harness: "other" });
    await settle();
    await until(() => reminders(other, engaged.agent.sessionId).length === 1);
    await service.prompt(engaged.agent.sessionId, { text: "from the user" });
    service.messageAgent(sid, { to: "u", text: "more" }); // resets, but the user is engaged now
    await settle();
    await flush(20);
    expect(reminders(other, engaged.agent.sessionId)).toHaveLength(1);

    const team = (service as unknown as {
      team: { agentTurnEnded(id: string, clean: boolean): void; ctx: { agents: { update(id: string, patch: { reminded: boolean }): void } } };
    }).team;
    const stopped = await service.spawnAgent(sid, { name: "s", task: "t", harness: "other" });
    await settle();
    await until(() => reminders(other, stopped.agent.sessionId).length === 1);
    // Let its reminded turn end for real, then re-arm it directly: a natural turn end racing the
    // simulated stop below would add a legitimate reminder (flaky under load).
    await settle();
    await flush(20);
    team.ctx.agents.update(stopped.agent.sessionId, { reminded: false });
    const before = fakeOf(other, stopped.agent.sessionId).prompts.length;
    team.agentTurnEnded(stopped.agent.sessionId, false);
    await settle();
    expect(fakeOf(other, stopped.agent.sessionId).prompts.length).toBe(before);
  });
});

describe("sub-agent switches (I-221)", () => {
  const off = () => service.updateSettings({ agent: { subagentOtherHarnesses: false, subagentOtherModels: false } });
  const SWITCHED = "Sub-agents on other agents are turned off in Glade (Settings → Sub-agents)";

  it("other agents off: the child stays on the chat's harness; an explicit other harness or a pinned agent is a 400", async () => {
    off();
    const sid = await parent();
    defs.defs.set("scout", def({ name: "scout", harness: "other" }));
    defs.defs.set("local", def({ name: "local", harness: "fake" }));
    await expect(service.spawnAgent(sid, { name: "x", task: "t", harness: "other" })).rejects.toMatchObject({ status: 400, message: expect.stringContaining(SWITCHED) });
    await expect(service.spawnAgent(sid, { name: "y", task: "t", agent: "scout" })).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/Settings → Sub-agents\), so the agent "scout" \(it runs on Other Agent\) can't start/),
    });
    // The chat's own harness (named or via an agent pinned to it) and inherit are fine.
    const named = await service.spawnAgent(sid, { name: "a", task: "t", harness: "fake" });
    const pinned = await service.spawnAgent(sid, { name: "b", task: "t", agent: "local" });
    const plain = await service.spawnAgent(sid, { name: "c", task: "t" });
    for (const { agent } of [named, pinned, plain]) expect(store.getSession(agent.sessionId)!.harness).toBe("fake");
  });

  it("other models off: the chat's model and thinking, whatever the request, the definition or the settings say", async () => {
    off();
    service.updateSettings({ models: { agents: { fake: { subagentModel: { provider: "fake", id: "fast" }, subagentThinkingLevel: "low" } } } });
    const sid = await parent();
    defs.defs.set("quick", def({ name: "quick", harness: "fake", model: "fake/fast", thinking: "off", prompt: "Be quick.", tools: ["read"] }));
    const { agent } = await service.spawnAgent(sid, { name: "a", task: "t", agent: "quick", model: "fast", thinking: "off" });
    expect(store.getSession(agent.sessionId)).toMatchObject({ model: { provider: "fake", id: "smart" }, thinkingLevel: "high" });
    // Prompt, tools and identity of the definition still apply.
    expect(main.opened.at(-1)!.agentDefinition).toMatchObject({ name: "quick", prompt: "Be quick.", tools: ["read"] });
    expect(main.opened.at(-1)!.tools).toEqual(["read", "report_done", "message_agent"]);
    // Without a definition: the sub-agent setting is ignored too.
    const plain = await service.spawnAgent(sid, { name: "b", task: "t" });
    expect(store.getSession(plain.agent.sessionId)).toMatchObject({ model: { provider: "fake", id: "smart" }, thinkingLevel: "high" });
    // An invalid thinking level is still a 400.
    await expect(service.spawnAgent(sid, { name: "c", task: "t", thinking: "lots" })).rejects.toThrow(/thinking/);
  });

  it("other agents on, other models off: another harness gets its own defaults, not the sub-agent settings", async () => {
    service.updateSettings({ agent: { subagentOtherHarnesses: true, subagentOtherModels: false }, models: { agents: { other: { subagentModel: { provider: "other", id: "tiny" } } } } });
    const sid = await parent();
    const { agent } = await service.spawnAgent(sid, { name: "x", task: "t", harness: "other", model: "tiny" });
    expect(store.getSession(agent.sessionId)).toMatchObject({ harness: "other", model: { provider: "other", id: "big" } });
  });

  it("both on: the definition's harness and model apply (today's behaviour)", async () => {
    service.updateSettings({ agent: { subagentOtherHarnesses: true, subagentOtherModels: true } });
    const sid = await parent();
    defs.defs.set("tiny", def({ name: "tiny", harness: "other", model: "other/tiny" }));
    const { agent } = await service.spawnAgent(sid, { name: "x", task: "t", agent: "tiny" });
    expect(store.getSession(agent.sessionId)).toMatchObject({ harness: "other", model: { provider: "other", id: "tiny" } });
  });

  it("the spawnable list follows the switches: no other-harness agents or harness list, no models", async () => {
    const sid = await parent();
    defs.defs.set("scout", def({ name: "scout", harness: "other", model: "other/tiny" }));
    defs.defs.set("local", def({ name: "local", harness: "fake", model: "fake/fast" }));
    defs.defs.set("writer", def({ name: "writer" }));
    off();
    let list = await service.spawnableAgents(sid);
    expect(list.agents).toEqual([
      { name: "local", description: "local agent", harness: "fake", harnessLabel: "Fake agent", model: null, readOnly: false },
      { name: "writer", description: "writer agent", harness: null, harnessLabel: null, model: null, readOnly: false },
    ]);
    expect(list.harnesses).toEqual([{ id: "fake", label: "Fake agent" }]);
    expect(spawnAgentSpecFor(list).parameters.properties).not.toHaveProperty("harness");
    // The settings list context carries the switches (they add the notes).
    expect(defs.lists.at(-1)!.ctx).toMatchObject({ otherHarnesses: false, otherModels: false });
    service.updateSettings({ agent: { subagentOtherModels: true } });
    list = await service.spawnableAgents(sid);
    expect(list.agents.map((a) => a.model)).toEqual(["fast", null]);
    service.updateSettings({ agent: { subagentOtherHarnesses: true } });
    list = await service.spawnableAgents(sid);
    expect(list.agents.map((a) => a.name)).toEqual(["scout", "local", "writer"]);
    expect(list.harnesses.map((h) => h.id)).toEqual(["fake", "other"]);
    expect(spawnAgentSpecFor(list).parameters.properties).toHaveProperty("harness");
  });
});

describe("pickAgentIdentity with a definition (I-218)", () => {
  it("nicknames, numbering, a set colour even when taken, the icon", () => {
    expect(pickAgentIdentity([], [], Math.random, { nicknames: ["Brandon"], color: "teal", icon: "search" })).toEqual({ displayName: "Brandon", color: "teal", icon: "search" });
    const taken = [{ displayName: "Brandon", color: "teal" }, { displayName: "Brandon 2" }];
    expect(pickAgentIdentity(taken, [], Math.random, { nicknames: ["Brandon"], color: "teal" })).toMatchObject({ displayName: "Brandon 3", color: "teal" });
    expect(pickAgentIdentity([{ displayName: "brandon" }], [], Math.random, { nicknames: ["Brandon", "Bea"] }).displayName).toBe("Bea");
    // No nicknames: the random pool; an unknown colour is ignored.
    const id = pickAgentIdentity([], [], () => 0, { color: "nope" as never });
    expect(id.displayName).toBe("Maya");
    expect(id.icon).toBeUndefined();
  });
});
