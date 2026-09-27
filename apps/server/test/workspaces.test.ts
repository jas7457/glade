/**
 * I-035: workspaces with several sessions (main tabs + sub-agents): creation, roll-up, titles,
 * deleting tabs, and per-session live processes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, WorkspaceSummary } from "@glade/protocol";
import type { FakeSession } from "../src/harness/fake/fake-harness.js";
import { createTestEnv, deferred, flush, newChat, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => {
  env = createTestEnv();
});
afterEach(async () => {
  await env.cleanup();
});

/** The fake agent process of a session (matched by its session file). */
function fakeOf(sessionId: string): FakeSession {
  const ref = env.store.getSession(sessionId)!.sessionRef;
  return [...env.harness.openSessions].find((s) => s.sessionRef === ref)!;
}
const emit = (sessionId: string, ...events: AgentEvent[]) => events.forEach((e) => fakeOf(sessionId).emit(e));
const workspace = (id: string): WorkspaceSummary => env.service.listWorkspaces().find((w) => w.id === id)!;

describe("main sessions (tabs)", () => {
  it("adds a tab with its own agent in the workspace's folder", async () => {
    const chat = await newChat(env, { prompt: "first" });
    await flush();
    env.messages.length = 0;
    const tab = await env.service.createSession(chat.wid, { prompt: "second tab" });
    await flush();

    expect(tab.session).toMatchObject({ workspaceId: chat.wid, kind: "main", parentSessionId: null, title: "Generated: second tab" });
    expect(tab.session.id).not.toBe(chat.sid);
    expect(env.service.liveCount).toBe(2);
    expect(fakeOf(tab.session.id).cwd).toBe(env.store.getWorkspace(chat.wid)!.cwd);
    expect(env.service.getWorkspaceDetail(chat.wid).sessions.map((s) => s.id)).toEqual([chat.sid, tab.session.id]);
    expect(env.messages).toContainEqual({ type: "session_upsert", session: expect.objectContaining({ id: tab.session.id }) });
    // Transcripts are separate.
    const first = await env.service.getSessionDetail(chat.sid);
    const second = await env.service.getSessionDetail(tab.session.id);
    expect(first.transcript.messages[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(first.transcript)).not.toContain("second tab");
    expect(JSON.stringify(second.transcript)).toContain("second tab");
  });

  it("only the first main session's title feeds an auto workspace title", async () => {
    const chat = await newChat(env, { prompt: "fix login" });
    await flush();
    expect(workspace(chat.wid).title).toBe("Generated: fix login");
    await env.service.createSession(chat.wid, { prompt: "unrelated" });
    await flush();
    expect(workspace(chat.wid).title).toBe("Generated: fix login");
  });

  it("an empty workspace takes its title from the first prompt, later", async () => {
    const title = deferred<string | null>();
    env.harness.generateTitle = () => title.promise;
    const chat = await newChat(env);
    expect(workspace(chat.wid).title).toBe("New chat");
    await env.service.prompt(chat.sid, { text: "Hello there" });
    expect(workspace(chat.wid).title).toBe("Hello there");
    title.resolve("Greeting");
    await flush();
    expect(workspace(chat.wid).title).toBe("Greeting");
    expect(env.store.getSession(chat.sid)?.title).toBe("Greeting");
  });

  it("renaming a workspace with several tabs leaves the tab titles alone; tabs rename separately", async () => {
    const chat = await newChat(env, { prompt: "one" });
    const tab = await env.service.createSession(chat.wid, { prompt: "two" });
    await flush();
    await env.service.updateWorkspace(chat.wid, { title: "Project work" });
    expect(env.store.getSession(chat.sid)?.title).toBe("Generated: one");
    const renamed = await env.service.updateSession(tab.session.id, { title: " Tests " });
    expect(renamed).toMatchObject({ title: "Tests", titleSource: "user" });
    expect(workspace(chat.wid).title).toBe("Project work");
    expect(env.harness.sessions.get(env.store.getSession(tab.session.id)!.sessionRef!)?.title).toBe("Tests");
  });

  it("rolls up status across sessions and clears per session", async () => {
    const chat = await newChat(env);
    const tab = await env.service.createSession(chat.wid, {});
    env.messages.length = 0;

    emit(chat.sid, { type: "run_start" });
    expect(workspace(chat.wid)).toMatchObject({ status: "working", running: true });
    emit(tab.session.id, { type: "run_start" }, { type: "ui_request", request: { id: "q", kind: "confirm", title: "?" } });
    expect(workspace(chat.wid)).toMatchObject({ status: "blocked", pendingInputs: 1 });
    env.service.respondToUi(tab.session.id, { id: "q", confirmed: true });
    emit(tab.session.id, { type: "run_end" });
    expect(workspace(chat.wid)).toMatchObject({ status: "working", unread: true });
    emit(chat.sid, { type: "run_end" });
    expect(workspace(chat.wid)).toMatchObject({ status: "unread", running: false });

    // Every session change is followed by a workspace_upsert with the new roll-up.
    const last = env.messages.filter((m) => m.type === "workspace_upsert").at(-1);
    expect(last).toMatchObject({ type: "workspace_upsert", workspace: { id: chat.wid, status: "unread" } });

    env.service.setViewing(tab.session.id, true);
    expect(workspace(chat.wid).status).toBe("unread"); // the first tab is still unread
    env.service.setViewing(chat.sid, true);
    expect(workspace(chat.wid).status).toBe("idle");
  });

  it("run activity bumps the workspace's lastActivityAt", async () => {
    const chat = await newChat(env);
    const before = env.store.getWorkspace(chat.wid)!.lastActivityAt;
    await flush(5);
    emit(chat.sid, { type: "run_start" });
    expect(env.store.getWorkspace(chat.wid)!.lastActivityAt).toBeGreaterThan(before);
  });

  it("closing a tab deletes its session file; the last main session can't be closed", async () => {
    const chat = await newChat(env, { prompt: "x" });
    const tab = await env.service.createSession(chat.wid, { prompt: "y" });
    await flush();
    const ref = env.store.getSession(tab.session.id)!.sessionRef!;
    env.messages.length = 0;

    await env.service.deleteSession(tab.session.id);
    expect(env.harness.sessions.has(ref)).toBe(false);
    expect(env.store.getSession(tab.session.id)).toBeUndefined();
    expect(env.service.liveCount).toBe(1);
    expect(env.messages).toContainEqual({ type: "session_removed", sessionId: tab.session.id, workspaceId: chat.wid });
    expect(env.messages.at(-1)).toMatchObject({ type: "workspace_upsert", workspace: { id: chat.wid } });

    await expect(env.service.deleteSession(chat.sid)).rejects.toMatchObject({ status: 409 });
    expect(env.store.getSession(chat.sid)).toBeDefined();
  });

  it("a session that fails to start is removed again", async () => {
    const chat = await newChat(env);
    env.harness.openSession = async () => {
      throw new Error("no agent");
    };
    await expect(env.service.createSession(chat.wid, {})).rejects.toThrow("no agent");
    expect(env.store.listSessions(chat.wid).map((s) => s.id)).toEqual([chat.sid]);
    expect(env.messages.some((m) => m.type === "session_removed")).toBe(true);
  });

  it("layout is stored as given and returned with the workspace", async () => {
    const chat = await newChat(env);
    const layout = { mainOrder: [chat.sid], activeMainSessionId: chat.sid, subagentPaneSize: 0.4 };
    expect((await env.service.updateWorkspace(chat.wid, { layout })).layout).toEqual(layout);
    expect(env.store.getWorkspace(chat.wid)?.layout).toEqual(layout);
    expect((await env.service.updateWorkspace(chat.wid, { layout: null })).layout).toBeNull();
  });
});

describe("sub-agent sessions (for I-037)", () => {
  it("are created under a parent, count towards the roll-up and go when the parent tab closes", async () => {
    const chat = await newChat(env);
    const tab = await env.service.createSession(chat.wid, {});
    const sub = await env.service.createSession(chat.wid, { prompt: "review" }, { kind: "subagent", parentSessionId: tab.session.id, agentName: "reviewer" });
    await flush();
    expect(sub.session).toMatchObject({ kind: "subagent", parentSessionId: tab.session.id, agentName: "reviewer", title: "reviewer", titleSource: "user" });
    // Sub-agents never rename the workspace.
    expect(workspace(chat.wid).title).toBe("New chat");
    expect(env.service.getWorkspaceDetail(chat.wid).sessions.map((s) => s.kind)).toEqual(["main", "main", "subagent"]);

    emit(sub.session.id, { type: "run_start" });
    expect(workspace(chat.wid).status).toBe("working");
    emit(sub.session.id, { type: "run_end" });

    await env.service.deleteSession(tab.session.id);
    expect(env.store.listSessions(chat.wid).map((s) => s.id)).toEqual([chat.sid]);
    expect(env.messages).toContainEqual({ type: "session_removed", sessionId: sub.session.id, workspaceId: chat.wid });
  });

  it("reject a parent from another workspace", async () => {
    const a = await newChat(env);
    const b = await newChat(env);
    await expect(
      env.service.createSession(a.wid, {}, { kind: "subagent", parentSessionId: b.sid, agentName: "x" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("deleting a workspace", () => {
  it("stops and deletes every session", async () => {
    const chat = await newChat(env, { prompt: "a" });
    await env.service.createSession(chat.wid, { prompt: "b" });
    await flush();
    const refs = env.store.listSessions(chat.wid).map((s) => s.sessionRef!);
    await env.service.deleteWorkspace(chat.wid);
    expect(refs.every((r) => !env.harness.sessions.has(r))).toBe(true);
    expect(env.store.listSessions()).toEqual([]);
    expect(env.service.liveCount).toBe(0);
    expect(env.messages.at(-1)).toEqual({ type: "workspace_removed", workspaceId: chat.wid });
  });
});
