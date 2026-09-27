/**
 * I-084: sub-agents get a fun name and a colour at spawn, unique among the workspace's active
 * agents, stored on the session and the agent record, and freed when they close.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_COLORS, MAX_ACTIVE_AGENTS } from "@glade/protocol";
import { AGENT_DISPLAY_NAMES, pickAgentIdentity } from "../src/services/agent-names.js";
import { createTestEnv, flush, newChat, until, type TestEnv } from "./helpers.js";

describe("pickAgentIdentity", () => {
  it("has ~60 distinct names", () => {
    expect(AGENT_DISPLAY_NAMES.length).toBeGreaterThanOrEqual(55);
    expect(new Set(AGENT_DISPLAY_NAMES.map((n) => n.toLowerCase())).size).toBe(AGENT_DISPLAY_NAMES.length);
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
    const id = pickAgentIdentity(all, () => 0);
    expect(id.displayName).toBe(`${AGENT_DISPLAY_NAMES[0]} 2`);
    expect(pickAgentIdentity(all.slice(1), () => 0.99).displayName).toBe(AGENT_DISPLAY_NAMES[0]);
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
    for (let i = 0; i < 40 && !seen.has(agentColor!); i++) {
      const id = (await env.service.spawnAgent(chat.sid, { name: `n${i}`, task: "t" })).agent.sessionId;
      await settle();
      seen.add(env.store.getSession(id)!.agentColor!);
      env.service.reportAgentDone(id, { summary: "done" });
      await until(() => !env.store.getSession(id));
    }
    expect(seen.has(agentColor!)).toBe(true);
  });
});
