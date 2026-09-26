import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantMessage } from "@pi-ui/protocol";
import type { FakeSession } from "../src/harness/fake/fake-harness.js";
import { HttpError, decodedBase64Size } from "../src/services/app-service.js";
import { createTestEnv, deferred, flush, until, type TestEnv } from "./helpers.js";

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

  it("deleteProject removes the project and its chats", async () => {
    const project = env.service.createProject({ path: projectDir() });
    const inProject = await env.service.createChat({ projectId: project.id });
    const standalone = await env.service.createChat({ projectId: null });
    expect(inProject.chat.cwd).toBe(project.path);

    await env.service.deleteProject(project.id);
    expect(env.service.listProjects()).toEqual([]);
    expect(env.service.listChats().map((c) => c.id)).toEqual([standalone.chat.id]);
    expect(env.messages).toContainEqual({ type: "chat_removed", chatId: inProject.chat.id });
    expect(env.messages).toContainEqual({ type: "project_removed", projectId: project.id });
  });
});

describe("chats", () => {
  it("creates a chat with a prompt: quick title, then generated title, full transcript", async () => {
    const title = deferred<string | null>();
    env.harness.generateTitle = () => title.promise;

    const detail = await env.service.createChat({ projectId: null, prompt: "# Fix the *login* bug\nmore details" });
    expect(detail.chat.title).toBe("Fix the login bug");
    expect(detail.chat.titleSource).toBe("auto");
    expect(detail.chat.sessionRef).toMatch(/^fake-session-/);

    await flush();
    const after = await env.service.getChatDetail(detail.chat.id);
    const roles = after.transcript.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "assistant"]);
    const answer = after.transcript.messages[2] as AssistantMessage;
    expect(answer.content).toEqual([{ type: "text", text: "You said: # Fix the *login* bug\nmore details" }]);
    const results = Object.values(after.transcript.toolResults);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolName: "bash", status: "done", output: "hi\n" });

    title.resolve("Login bug fix");
    await flush();
    expect(env.store.getChat(detail.chat.id)?.title).toBe("Login bug fix");
    expect(env.store.getChat(detail.chat.id)?.titleSource).toBe("auto");
  });

  it("uses the default generated title from the fake harness", async () => {
    const detail = await env.service.createChat({ projectId: null, prompt: "hello there" });
    await flush();
    expect(env.store.getChat(detail.chat.id)?.title).toBe("Generated: hello there");
  });

  it("does not generate titles when disabled", async () => {
    env.service.updateSettings({ general: { generateTitles: false } });
    const detail = await env.service.createChat({ projectId: null, prompt: "hello there" });
    await flush();
    expect(env.store.getChat(detail.chat.id)?.title).toBe("hello there");
  });

  it("user titles are never overwritten by generated ones", async () => {
    const title = deferred<string | null>();
    env.harness.generateTitle = () => title.promise;
    const detail = await env.service.createChat({ projectId: null, prompt: "hello" });
    const updated = await env.service.updateChat(detail.chat.id, { title: "  Mine  " });
    expect(updated).toMatchObject({ title: "Mine", titleSource: "user" });
    title.resolve("Generated");
    await flush();
    expect(env.store.getChat(detail.chat.id)).toMatchObject({ title: "Mine", titleSource: "user" });
    await expect(env.service.updateChat(detail.chat.id, { title: " " })).rejects.toThrow(HttpError);
  });

  it("tracks running and marks unread when a run ends off screen", async () => {
    const detail = await env.service.createChat({ projectId: null });
    const id = detail.chat.id;
    env.messages.length = 0;
    await env.service.prompt(id, { text: "hi" });
    await flush();

    const upserts = env.messages.flatMap((m) => (m.type === "chat_upsert" && m.chat.id === id ? [m.chat] : []));
    expect(upserts.some((c) => c.running)).toBe(true);
    expect(upserts.at(-1)).toMatchObject({ running: false, unread: true });
    expect(env.service.listChats()[0]).toMatchObject({ running: false, unread: true });

    // Viewing the chat clears unread.
    env.service.setViewing(id, true);
    expect(env.store.getChat(id)?.unread).toBe(false);
  });

  it("does not mark unread when the chat is being viewed", async () => {
    const detail = await env.service.createChat({ projectId: null });
    const id = detail.chat.id;
    env.service.setViewing(id, true);
    await env.service.prompt(id, { text: "hi" });
    await flush();
    expect(env.store.getChat(id)?.unread).toBe(false);

    // Once nobody views it any more, the next run marks it unread.
    env.service.setViewing(id, false);
    await env.service.prompt(id, { text: "again" });
    await flush();
    expect(env.store.getChat(id)?.unread).toBe(true);
  });

  it("rejects empty prompts", async () => {
    const detail = await env.service.createChat({ projectId: null });
    await expect(env.service.prompt(detail.chat.id, { text: "  " })).rejects.toThrow(/empty/);
  });

  it("rejects images over the model's size limit with a clear 400", async () => {
    const detail = await env.service.createChat({ projectId: null }); // fake/smart: 1 MB limit
    const session = fakeSessions()[0]!;
    const small = { mimeType: "image/jpeg", data: Buffer.alloc(1000).toString("base64") };
    const big = { mimeType: "image/jpeg", data: Buffer.alloc(1024 * 1024 + 1).toString("base64") };

    const err = await env.service.prompt(detail.chat.id, { text: "look", images: [small, big] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 400, message: "Image 2 is too large (1 MB); this model accepts images up to 1 MB" });
    expect(session.prompts).toHaveLength(0);

    await env.service.prompt(detail.chat.id, { text: "look", images: [small] });
    expect(session.prompts).toHaveLength(1);
  });

  it("falls back to the default image limit for models without one", async () => {
    const detail = await env.service.createChat({ projectId: null, model: { provider: "fake", id: "fast" } });
    const image = (bytes: number) => ({ mimeType: "image/png", data: Buffer.alloc(bytes).toString("base64") });
    await env.service.prompt(detail.chat.id, { text: "", images: [image(2 * 1024 * 1024)] });
    await expect(env.service.prompt(detail.chat.id, { text: "", images: [image(5 * 1024 * 1024)] })).rejects.toThrow(
      /The image is too large \(5 MB\); this model accepts images up to 4.5 MB/,
    );
  });

  it("decodedBase64Size matches Buffer", () => {
    for (const n of [0, 1, 2, 3, 100, 1001]) expect(decodedBase64Size(Buffer.alloc(n).toString("base64"))).toBe(n);
  });

  it("deleteChat removes it from the store and the harness", async () => {
    const detail = await env.service.createChat({ projectId: null, prompt: "x" });
    await flush();
    const ref = detail.chat.sessionRef!;
    expect(env.harness.sessions.has(ref)).toBe(true);
    await env.service.deleteChat(detail.chat.id);
    expect(env.store.getChat(detail.chat.id)).toBeUndefined();
    expect(env.harness.sessions.has(ref)).toBe(false);
    expect(env.harness.openSessions.size).toBe(0);
    expect(env.service.liveCount).toBe(0);
    await expect(env.service.getChatDetail(detail.chat.id)).rejects.toMatchObject({ status: 404 });
  });

  it("reopens a persisted session with its transcript", async () => {
    const detail = await env.service.createChat({ projectId: null, prompt: "remember me" });
    await flush();
    // Crash-free close: evict everything by setting the limit to 0 and finishing another run.
    env.service.updateSettings({ agent: { maxIdleProcesses: 0 } });
    const other = await env.service.createChat({ projectId: null, prompt: "other" });
    await flush();
    const ref = detail.chat.sessionRef;
    expect(fakeSessions().some((x) => x.sessionRef === ref)).toBe(false);
    const reopened = await env.service.getChatDetail(detail.chat.id);
    expect(reopened.transcript.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(other.chat.id).not.toBe(detail.chat.id);
  });

  it("setModel / setThinkingLevel update the chat record", async () => {
    const detail = await env.service.createChat({ projectId: null });
    await env.service.setModel(detail.chat.id, { provider: "fake", id: "fast" });
    expect(env.store.getChat(detail.chat.id)?.model).toEqual({ provider: "fake", id: "fast" });
    expect(env.store.getChat(detail.chat.id)?.thinkingLevel).toBe("off"); // clamped for a non-reasoning model
    await env.service.setModel(detail.chat.id, { provider: "fake", id: "smart" });
    await env.service.setThinkingLevel(detail.chat.id, "high");
    expect(env.store.getChat(detail.chat.id)?.thinkingLevel).toBe("high");
  });

  it("tracks pending UI requests and forwards responses", async () => {
    const detail = await env.service.createChat({ projectId: null });
    const session = fakeSessions()[0]!;
    session.emit({ type: "ui_request", request: { id: "q1", kind: "confirm", title: "Sure?" } });
    expect((await env.service.getChatDetail(detail.chat.id)).pendingUiRequests).toHaveLength(1);
    env.service.respondToUi(detail.chat.id, { id: "q1", confirmed: true });
    expect(session.uiResponses).toEqual([{ id: "q1", confirmed: true }]);
    expect((await env.service.getChatDetail(detail.chat.id)).pendingUiRequests).toHaveLength(0);
    expect(env.messages).toContainEqual({
      type: "chat_event",
      chatId: detail.chat.id,
      event: { type: "ui_request_closed", id: "q1" },
    });
  });
});

describe("session pool", () => {
  it("evicts least recently used idle sessions beyond maxIdleProcesses", async () => {
    env.service.updateSettings({ agent: { maxIdleProcesses: 1 } });
    const a = await env.service.createChat({ projectId: null });
    const b = await env.service.createChat({ projectId: null });
    const c = await env.service.createChat({ projectId: null });
    // The session just opened is never evicted, so at most max + 1 are alive here.
    expect(env.service.liveCount).toBeLessThanOrEqual(2);

    await env.service.prompt(c.chat.id, { text: "go" });
    await flush();
    expect(env.service.liveCount).toBe(1);
    expect(env.harness.openSessions.size).toBe(1);
    expect(fakeSessions()[0]!.prompts[0]?.text).toBe("go");
    expect([a, b].every((x) => env.store.getChat(x.chat.id))).toBe(true);
  });

  it("never evicts running or viewed sessions", async () => {
    env.service.updateSettings({ agent: { maxIdleProcesses: 0 } });
    env.harness.eventDelayMs = 5;
    const a = await env.service.createChat({ projectId: null });
    env.service.setViewing(a.chat.id, true);
    const b = await env.service.createChat({ projectId: null, prompt: "slow" });
    await until(() => env.service.listChats().some((x) => x.id === b.chat.id && x.running));
    // b is running, a is viewed.
    const c = await env.service.createChat({ projectId: null });
    expect(env.service.listChats().find((x) => x.id === b.chat.id)?.running).toBe(true);
    expect(env.service.liveCount).toBe(3);
    await until(() => !env.service.listChats().some((x) => x.running));
    // After b's run ended only the viewed chat (a) survives the eviction pass.
    expect(env.service.liveCount).toBe(1);
    expect(c.chat.id).toBeTruthy();
    expect((await env.service.getChatDetail(a.chat.id)).chat.id).toBe(a.chat.id);
  });

  it("a crashed session leaves the pool and reports error + run_end", async () => {
    const detail = await env.service.createChat({ projectId: null });
    const session = fakeSessions()[0]!;
    env.messages.length = 0;
    session.crash("segfault");
    expect(env.service.liveCount).toBe(0);
    const events = env.messages.flatMap((m) => (m.type === "chat_event" && m.chatId === detail.chat.id ? [m.event] : []));
    expect(events).toContainEqual({ type: "error", message: "segfault" });
    expect(events).toContainEqual({ type: "run_end" });
    expect(env.messages).toContainEqual({ type: "chat_upsert", chat: expect.objectContaining({ id: detail.chat.id, running: false }) });
    // Opening the chat again starts a fresh session.
    await env.service.getChatDetail(detail.chat.id);
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
    expect(s.appearance).toEqual({ theme: "dark", fontSize: "medium" });
    expect(env.messages).toContainEqual({ type: "settings", settings: s });
  });
});
