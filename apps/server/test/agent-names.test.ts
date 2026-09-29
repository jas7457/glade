/**
 * I-084: sub-agents get a fun name and a colour at spawn, unique among the workspace's active
 * agents, stored on the session and the agent record, and freed when they close.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_COLORS, MAX_ACTIVE_AGENTS } from "@glade/protocol";
import { AGENT_DISPLAY_NAMES, pickAgentIdentity } from "../src/services/agent-names.js";
import { createTestEnv, flush, newChat, until, type TestEnv } from "./helpers.js";

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length]!;
}

describe("pickAgentIdentity", () => {
  it("has ~300 distinct names, none too alike", () => {
    expect(AGENT_DISPLAY_NAMES.length).toBeGreaterThanOrEqual(290);
    const lower = AGENT_DISPLAY_NAMES.map((n) => n.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
    expect(new Set(lower.map((n) => n.slice(0, 3))).size).toBe(lower.length);
    // Arlo/Marlo predate I-144 and are kept; no other pair is one edit apart.
    const alike: string[] = [];
    for (let i = 0; i < lower.length; i++) {
      for (let j = i + 1; j < lower.length; j++) if (editDistance(lower[i]!, lower[j]!) <= 1) alike.push(`${lower[i]}~${lower[j]}`);
    }
    expect(alike).toEqual(["arlo~marlo"]);
    for (const n of AGENT_DISPLAY_NAMES) expect(n).toMatch(/^[A-Z][a-z]+$/);
  });

  it("doesn't repeat a name the chat has used until all are used, then picks the least recently used", () => {
    const history: string[] = [];
    for (let i = 0; i < AGENT_DISPLAY_NAMES.length; i++) history.push(pickAgentIdentity([], history).displayName);
    expect(new Set(history).size).toBe(AGENT_DISPLAY_NAMES.length);
    // All used: the oldest comes back first, then the next oldest.
    expect(pickAgentIdentity([], history).displayName).toBe(history[0]);
    const again = [...history, history[0]!];
    expect(pickAgentIdentity([], again).displayName).toBe(history[1]);
    // A name used again later counts as recent.
    expect(pickAgentIdentity([], [...history, history[0]!, history[1]!]).displayName).toBe(history[2]);
  });

  it("stays unique among active agents even when that name is the least recently used", () => {
    const history = [...AGENT_DISPLAY_NAMES];
    const active = [{ displayName: history[0] }, { displayName: history[1] }];
    expect(pickAgentIdentity(active, history).displayName).toBe(history[2]);
    // Fresh names still beat active-free used ones, and never an active one.
    for (let i = 0; i < 20; i++) {
      const id = pickAgentIdentity(active, history.slice(0, -3));
      expect(history.slice(-3)).toContain(id.displayName);
    }
  });

  it("never reuses an active name or colour while one is free", () => {
    const taken: Array<{ displayName: string; color: string }> = [];
    for (let i = 0; i < AGENT_COLORS.length; i++) {
      const id = pickAgentIdentity(taken);
      expect(taken.map((t) => t.displayName)).not.toContain(id.displayName);
      expect(taken.map((t) => t.color)).not.toContain(id.color);
      taken.push(id);
    }
    expect(new Set(taken.map((t) => t.color)).size).toBe(AGENT_COLORS.length);
  });

  it("then picks one of the least used colours", () => {
    const taken = AGENT_COLORS.map((color) => ({ displayName: "x", color }));
    taken.push({ displayName: "y", color: "coral" });
    for (let i = 0; i < 20; i++) expect(pickAgentIdentity(taken).color).not.toBe("coral");
  });

  it("is case-insensitive about names and numbers one when all are taken", () => {
    const all = AGENT_DISPLAY_NAMES.map((displayName) => ({ displayName: displayName.toUpperCase() }));
    const id = pickAgentIdentity(all, [], () => 0);
    expect(id.displayName).toBe(`${AGENT_DISPLAY_NAMES[0]} 2`);
    expect(pickAgentIdentity(all.slice(1), [], () => 0.99).displayName).toBe(AGENT_DISPLAY_NAMES[0]);
  });
});

describe("spawned agent identities", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = createTestEnv();
    env.service.setServerUrl("http://127.0.0.1:4999");
    env.harness.script = () => [];
  });
  afterEach(async () => {
    await env.cleanup();
  });

  const settle = async () => {
    await flush();
    await env.service.settleAgentDeliveries();
    await flush();
  };

  it("stores a unique name and colour on the session, the record and the parent's spawnedAgents", async () => {
    const chat = await newChat(env);
    const ids: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_AGENTS; i++) {
      ids.push((await env.service.spawnAgent(chat.sid, { name: `a${i}`, task: "t" })).agent.sessionId);
      await settle();
    }
    const sessions = ids.map((id) => env.store.getSession(id)!);
    expect(new Set(sessions.map((s) => s.agentDisplayName)).size).toBe(MAX_ACTIVE_AGENTS);
    expect(new Set(sessions.map((s) => s.agentColor)).size).toBe(MAX_ACTIVE_AGENTS);
    for (const s of sessions) {
      expect(AGENT_DISPLAY_NAMES).toContain(s.agentDisplayName);
      expect(AGENT_COLORS).toContain(s.agentColor);
    }
    // The parent lists them, oldest first, with the same identity.
    const parent = env.service.listSessions(chat.wid).find((s) => s.id === chat.sid)!;
    expect(parent.spawnedAgents).toEqual(
      sessions.map((s) => expect.objectContaining({ name: s.agentName, sessionId: s.id, displayName: s.agentDisplayName, color: s.agentColor })),
    );
    // Sub-agents don't list anything.
    expect(env.service.listSessions(chat.wid).find((s) => s.id === ids[0])!.spawnedAgents).toBeUndefined();
    // Pushed to clients when spawned.
    expect(env.messages.some((m) => m.type === "session_upsert" && m.session.id === chat.sid && m.session.spawnedAgents?.length === MAX_ACTIVE_AGENTS)).toBe(true);
  });

  it("keeps a closed agent's identity for its parent and frees it for new agents", async () => {
    const chat = await newChat(env);
    const first = (await env.service.spawnAgent(chat.sid, { name: "scout", task: "t" })).agent.sessionId;
    await settle();
    const { agentDisplayName, agentColor } = env.store.getSession(first)!;
    env.service.reportAgentDone(first, { summary: "done" });
    await until(() => !env.store.getSession(first));
    const parent = env.service.listSessions(chat.wid).find((s) => s.id === chat.sid)!;
    expect(parent.spawnedAgents).toEqual([expect.objectContaining({ name: "scout", sessionId: first, displayName: agentDisplayName, color: agentColor })]);
    // Only active agents count: the next one may get any colour, e.g. the freed one.
    const seen = new Set<string>();
    const names = [agentDisplayName];
    for (let i = 0; i < 40 && !seen.has(agentColor!); i++) {
      const id = (await env.service.spawnAgent(chat.sid, { name: `n${i}`, task: "t" })).agent.sessionId;
      await settle();
      seen.add(env.store.getSession(id)!.agentColor!);
      names.push(env.store.getSession(id)!.agentDisplayName);
      env.service.reportAgentDone(id, { summary: "done" });
      await until(() => !env.store.getSession(id));
    }
    expect(seen.has(agentColor!)).toBe(true);
    // …but names aren't reused within the chat, closed agents included (I-144).
    expect(new Set(names).size).toBe(names.length);
  });
});
