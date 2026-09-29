import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantMessage } from "@glade/protocol";
import type { FakeSession } from "../src/harness/fake/fake-harness.js";
import { HttpError, decodedBase64Size } from "../src/services/app-service.js";
import { createTestEnv, deferred, flush, newChat, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => {
  env = createTestEnv();
});
afterEach(async () => {
  await env.cleanup();
});

function projectDir(name = "proj"): string {
  const path = join(env.dir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function fakeSessions(): FakeSession[] {
  return [...env.harness.openSessions];
}

describe("projects", () => {
  it("creates a project for an existing folder and rejects anything else", () => {
    const path = projectDir("my-app");
    const project = env.service.createProject({ path });
    expect(project).toMatchObject({ name: "my-app", path, sortOrder: 0 });
    expect(project).not.toHaveProperty("pinned");
    expect(env.service.createProject({ path: `${path}/` }).id).toBe(project.id); // de-duplicated
    expect(env.messages).toContainEqual({ type: "project_upsert", project });

    expect(() => env.service.createProject({ path: join(env.dir, "missing") })).toThrow(HttpError);
    const file = join(env.dir, "file.txt");
    writeFileSync(file, "x");
    expect(() => env.service.createProject({ path: file })).toThrow(/Not a folder/);
    expect(() => env.service.createProject({ path: " " })).toThrow(HttpError);
  });

  it("deleteProject removes the project and its workspaces", async () => {
    const project = env.service.createProject({ path: projectDir() });
    const inProject = await newChat(env, { projectId: project.id });
    const standalone = await newChat(env, { projectId: null });
    expect(inProject.workspace.cwd).toBe(project.path);

    await env.service.deleteProject(project.id);
    expect(env.service.listProjects()).toEqual([]);
    expect(env.service.listWorkspaces().map((w) => w.id)).toEqual([standalone.wid]);
    expect(env.store.listSessions().map((x) => x.id)).toEqual([standalone.sid]);
    expect(env.messages).toContainEqual({ type: "workspace_removed", workspaceId: inProject.wid });
    expect(env.messages).toContainEqual({ type: "project_removed", projectId: project.id });
  });
});

describe("workspaces (single session)", () => {
  it("creates a chat with a prompt: quick title, then generated title, full transcript", async () => {
    const title = deferred<string | null>();
    env.harness.generateTitle = () => title.promise;

    const detail = await newChat(env, { projectId: null, prompt: "# Fix the *login* bug\nmore details" });
    expect(detail.workspace.title).toBe("Fix the login bug");
    expect(detail.workspace.titleSource).toBe("auto");
    expect(detail.session.title).toBe("Fix the login bug");
    expect(detail.session.sessionRef).toMatch(/^fake-session-/);
    expect(detail.session).toMatchObject({ kind: "main", workspaceId: detail.wid, parentSessionId: null });

    await flush();
    const after = await env.service.getSessionDetail(detail.sid);
    const roles = after.transcript.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "assistant"]);
    const answer = after.transcript.messages[2] as AssistantMessage;
    expect(answer.content).toEqual([{ type: "text", text: "You said: # Fix the *login* bug\nmore details" }]);
    const results = Object.values(after.transcript.toolResults);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolName: "bash", status: "done", output: "hi\n" });
    // I-070: the server stamps tool timing; the run is over, so no run start time.
    expect(typeof results[0]!.startedAt).toBe("number");
    expect(results[0]!.endedAt!).toBeGreaterThanOrEqual(results[0]!.startedAt!);
    expect(after.state.runStartedAt).toBeNull();

    title.resolve("Login bug fix");
    await flush();
    expect(env.store.getSession(detail.sid)?.title).toBe("Login bug fix");
    expect(env.store.getSession(detail.sid)?.titleSource).toBe("auto");
    // An auto workspace title follows its first main session.
    expect(env.store.getWorkspace(detail.wid)?.title).toBe("Login bug fix");
  });

  it("uses the default generated title from the fake harness", async () => {
    const detail = await newChat(env, { projectId: null, prompt: "hello there" });
    await flush();
    expect(env.store.getWorkspace(detail.wid)?.title).toBe("Generated: hello there");
  });

  it("does not generate titles when disabled", async () => {
    env.service.updateSettings({ general: { generateTitles: false } });
    const detail = await newChat(env, { projectId: null, prompt: "hello there" });
    await flush();
    expect(env.store.getWorkspace(detail.wid)?.title).toBe("hello there");
  });

  it("user titles are never overwritten by generated ones", async () => {
    const title = deferred<string | null>();
    env.harness.generateTitle = () => title.promise;
    const detail = await newChat(env, { projectId: null, prompt: "hello" });
    const updated = await env.service.updateWorkspace(detail.wid, { title: "  Mine  " });
    expect(updated).toMatchObject({ title: "Mine", titleSource: "user" });
    title.resolve("Generated");
    await flush();
    expect(env.store.getWorkspace(detail.wid)).toMatchObject({ title: "Mine", titleSource: "user" });
    // With one tab, renaming the workspace renames that session too.
    expect(env.store.getSession(detail.sid)).toMatchObject({ title: "Mine", titleSource: "user" });
    await expect(env.service.updateWorkspace(detail.wid, { title: " " })).rejects.toThrow(HttpError);
  });

  it("tracks running and marks unread when a run ends off screen", async () => {
    const detail = await newChat(env, { projectId: null });
    const id = detail.sid;
    env.messages.length = 0;
    await env.service.prompt(id, { text: "hi" });
    await flush();

    const upserts = env.messages.flatMap((m) => (m.type === "session_upsert" && m.session.id === id ? [m.session] : []));
    expect(upserts.some((c) => c.running)).toBe(true);
    expect(upserts.at(-1)).toMatchObject({ running: false, unread: true });
    const wsUpserts = env.messages.flatMap((m) => (m.type === "workspace_upsert" ? [m.workspace] : []));
    expect(wsUpserts.some((w) => w.status === "working")).toBe(true);
    expect(env.service.listWorkspaces()[0]).toMatchObject({ running: false, unread: true, status: "unread" });

    // Viewing the session clears unread.
    env.service.setViewing(id, true);
    expect(env.store.getSession(id)?.unread).toBe(false);
    expect(env.service.listWorkspaces()[0]?.status).toBe("idle");
  });

  it("does not mark unread when the chat is being viewed", async () => {
    const detail = await newChat(env, { projectId: null });
    const id = detail.sid;
    env.service.setViewing(id, true);
    await env.service.prompt(id, { text: "hi" });
    await flush();
    expect(env.store.getSession(id)?.unread).toBe(false);

    // Once nobody views it any more, the next run marks it unread.
    env.service.setViewing(id, false);
    await env.service.prompt(id, { text: "again" });
    await flush();
    expect(env.store.getSession(id)?.unread).toBe(true);
  });

  it("rejects empty prompts", async () => {
    const detail = await newChat(env, { projectId: null });
    await expect(env.service.prompt(detail.sid, { text: "  " })).rejects.toThrow(/empty/);
  });

  it("rejects images over the model's size limit with a clear 400", async () => {
    const detail = await newChat(env, { projectId: null }); // fake/smart: 1 MB limit
    const session = fakeSessions()[0]!;
    const small = { mimeType: "image/jpeg", data: Buffer.alloc(1000).toString("base64") };
    const big = { mimeType: "image/jpeg", data: Buffer.alloc(1024 * 1024 + 1).toString("base64") };

    const err = await env.service.prompt(detail.sid, { text: "look", images: [small, big] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 400, message: "Image 2 is too large (1 MB); this model accepts images up to 1 MB" });
    expect(session.prompts).toHaveLength(0);

    await env.service.prompt(detail.sid, { text: "look", images: [small] });
    expect(session.prompts).toHaveLength(1);
  });

  it("falls back to the default image limit for models without one", async () => {
    const detail = await newChat(env, { projectId: null, model: { provider: "fake", id: "fast" } });
    const image = (bytes: number) => ({ mimeType: "image/png", data: Buffer.alloc(bytes).toString("base64") });
    await env.service.prompt(detail.sid, { text: "", images: [image(2 * 1024 * 1024)] });
    await expect(env.service.prompt(detail.sid, { text: "", images: [image(5 * 1024 * 1024)] })).rejects.toThrow(
      /The image is too large \(5 MB\); this model accepts images up to 4.5 MB/,
    );
  });

  it("decodedBase64Size matches Buffer", () => {
    for (const n of [0, 1, 2, 3, 100, 1001]) expect(decodedBase64Size(Buffer.alloc(n).toString("base64"))).toBe(n);
  });

  it("deleteWorkspace removes it from the store and the harness", async () => {
    const detail = await newChat(env, { projectId: null, prompt: "x" });
    await flush();
    const ref = detail.session.sessionRef!;
    expect(env.harness.sessions.has(ref)).toBe(true);
    await env.service.deleteWorkspace(detail.wid);
    expect(env.store.getWorkspace(detail.wid)).toBeUndefined();
    expect(env.store.getSession(detail.sid)).toBeUndefined();
    expect(env.harness.sessions.has(ref)).toBe(false);
    expect(env.harness.openSessions.size).toBe(0);
    expect(env.service.liveCount).toBe(0);
    await expect(env.service.getSessionDetail(detail.sid)).rejects.toMatchObject({ status: 404 });
    expect(() => env.service.getWorkspaceDetail(detail.wid)).toThrow(/Workspace not found/);
  });

  it("reopens a persisted session with its transcript", async () => {
    // Crash-free close: evict everything with an idle limit of 0 and finishing another run.
    await env.cleanup();
    env = createTestEnv({ maxIdleProcesses: 0 });
    const detail = await newChat(env, { projectId: null, prompt: "remember me" });
    await flush();
    const other = await newChat(env, { projectId: null, prompt: "other" });
    await flush();
    const ref = detail.session.sessionRef;
    expect(fakeSessions().some((x) => x.sessionRef === ref)).toBe(false);
    const reopened = await env.service.getSessionDetail(detail.sid);
    expect(reopened.transcript.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(other.sid).not.toBe(detail.sid);
  });

  it("setModel / setThinkingLevel update the session record", async () => {
    const detail = await newChat(env, { projectId: null });
    await env.service.setModel(detail.sid, { provider: "fake", id: "fast" });
    expect(env.store.getSession(detail.sid)?.model).toEqual({ provider: "fake", id: "fast" });
    expect(env.store.getSession(detail.sid)?.thinkingLevel).toBe("off"); // clamped for a non-reasoning model
    await env.service.setModel(detail.sid, { provider: "fake", id: "smart" });
    await env.service.setThinkingLevel(detail.sid, "high");
    expect(env.store.getSession(detail.sid)?.thinkingLevel).toBe("high");
  });

  it("tracks pending UI requests and forwards responses", async () => {
    const detail = await newChat(env, { projectId: null });
    const session = fakeSessions()[0]!;
    session.emit({ type: "ui_request", request: { id: "q1", kind: "confirm", title: "Sure?" } });
    expect((await env.service.getSessionDetail(detail.sid)).pendingUiRequests).toHaveLength(1);
    env.service.respondToUi(detail.sid, { id: "q1", confirmed: true });
    expect(session.uiResponses).toEqual([{ id: "q1", confirmed: true }]);
    expect((await env.service.getSessionDetail(detail.sid)).pendingUiRequests).toHaveLength(0);
    expect(env.messages).toContainEqual({
      type: "session_event",
      sessionId: detail.sid,
      workspaceId: detail.wid,
      event: { type: "ui_request_closed", id: "q1" },
    });
  });
});

describe("session pool", () => {
  it("keeps at most 5 idle agent processes, with no setting for it (I-159)", async () => {
    const chats = [];
    for (let i = 0; i < 7; i++) chats.push(await newChat(env, { projectId: null }));
    await env.service.prompt(chats.at(-1)!.sid, { text: "go" });
    await flush();
    expect(env.service.liveCount).toBe(5);
    // An old stored value is ignored.
    env.service.updateSettings({ agent: { maxIdleProcesses: 1 } } as never);
    await env.service.prompt(chats.at(-1)!.sid, { text: "again" });
    await flush();
    expect(env.service.liveCount).toBe(5);
  });

  it("evicts least recently used idle sessions beyond the limit", async () => {
    await env.cleanup();
    env = createTestEnv({ maxIdleProcesses: 1 });
    const a = await newChat(env, { projectId: null });
    const b = await newChat(env, { projectId: null });
    const c = await newChat(env, { projectId: null });
    // The session just opened is never evicted, so at most max + 1 are alive here.
    expect(env.service.liveCount).toBeLessThanOrEqual(2);

    await env.service.prompt(c.sid, { text: "go" });
    await flush();
    expect(env.service.liveCount).toBe(1);
    expect(env.harness.openSessions.size).toBe(1);
    expect(fakeSessions()[0]!.prompts[0]?.text).toBe("go");
    expect([a, b].every((x) => env.store.getSession(x.sid))).toBe(true);
  });

  it("never evicts running or viewed sessions", async () => {
    await env.cleanup();
    env = createTestEnv({ maxIdleProcesses: 0 });
    env.harness.eventDelayMs = 5;
    const a = await newChat(env, { projectId: null });
    env.service.setViewing(a.sid, true);
    const b = await newChat(env, { projectId: null, prompt: "slow" });
    await until(() => env.service.listSessions().some((x) => x.id === b.sid && x.running));
    // b is running, a is viewed.
    const c = await newChat(env, { projectId: null });
    expect(env.service.listSessions().find((x) => x.id === b.sid)?.running).toBe(true);
    expect(env.service.liveCount).toBe(3);
    await until(() => !env.service.listSessions().some((x) => x.running));
    // After b's run ended only the viewed chat (a) survives the eviction pass.
    expect(env.service.liveCount).toBe(1);
    expect(c.sid).toBeTruthy();
    expect((await env.service.getSessionDetail(a.sid)).session.id).toBe(a.sid);
  });

  it("a crashed session leaves the pool and reports error + run_end", async () => {
    const detail = await newChat(env, { projectId: null });
    const session = fakeSessions()[0]!;
    env.messages.length = 0;
    session.crash("segfault");
    expect(env.service.liveCount).toBe(0);
    const events = env.messages.flatMap((m) => (m.type === "session_event" && m.sessionId === detail.sid ? [m.event] : []));
    expect(events).toContainEqual({ type: "error", message: "segfault" });
    expect(events).toContainEqual({ type: "run_end" });
    expect(env.messages).toContainEqual({ type: "session_upsert", session: expect.objectContaining({ id: detail.sid, running: false }) });
    // Opening the chat again starts a fresh session.
    await env.service.getSessionDetail(detail.sid);
    expect(env.service.liveCount).toBe(1);
  });
});

describe("models + settings", () => {
  it("lists models and broadcasts on forced refresh", async () => {
    expect((await env.service.listModels()).length).toBeGreaterThan(0);
    expect(env.messages.some((m) => m.type === "models")).toBe(false);
    await env.service.listModels(true);
    expect(env.messages.some((m) => m.type === "models")).toBe(true);
  });

  it("merges and broadcasts settings", () => {
    const s = env.service.updateSettings({ appearance: { theme: "dark" } });
    expect(s.appearance).toEqual({ theme: "dark" });
    expect(env.messages).toContainEqual({ type: "settings", settings: s });
  });
});
