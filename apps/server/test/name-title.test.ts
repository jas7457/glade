/**
 * I-074: `/name` without a title names the chat from its conversation with the small model
 * (`POST /api/sessions/:id/title/generate`), applied like a rename.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelInfo } from "@glade/protocol";
import { FAKE_MODELS } from "../src/harness/fake/fake-harness.js";
import { conversationExcerpt, titlePrompt } from "../src/harness/title.js";
import type { GenerateTitleOptions } from "../src/harness/types.js";
import { createApp } from "../src/http/app.js";
import { createTestEnv, newChat, until, type TestEnv } from "./helpers.js";

describe("conversationExcerpt", () => {
  const u = (text: string) => ({ role: "user" as const, text });
  const a = (text: string) => ({ role: "assistant" as const, text });

  it("keeps the first user message and the latest texts, marking the gap", () => {
    const messages = [a("hello"), u("first ask"), a("r1"), u("q2"), a("r2"), u("q3"), a("r3"), u("q4"), a("r4")];
    expect(conversationExcerpt(messages)).toBe(
      ["User: first ask", "[…]", "User: q2", "Assistant: r2", "User: q3", "Assistant: r3", "User: q4", "Assistant: r4"].join("\n\n"),
    );
    expect(conversationExcerpt([u("only"), a("  "), a("reply")])).toBe("User: only\n\nAssistant: reply");
    expect(conversationExcerpt([a("no user text")])).toBe("");
  });

  it("shortens long messages and stays under the cap", () => {
    const messages = [u("x".repeat(5000)), ...Array.from({ length: 10 }, (_, i) => a(`${i}`.repeat(2000)))];
    const excerpt = conversationExcerpt(messages, 3000);
    expect(excerpt.length).toBeLessThanOrEqual(3000);
    expect(excerpt.startsWith(`User: ${"x".repeat(1200)}…`)).toBe(true);
    expect(excerpt).toContain(`Assistant: ${"9".repeat(700)}…`);
  });

  it("shares the title prompt, with the conversation instead of the first message", () => {
    expect(titlePrompt("hi", "User: hi")).toContain("<conversation>\nUser: hi\n</conversation>");
    expect(titlePrompt("hi")).toContain("<message>\nhi\n</message>");
  });
});

let env: TestEnv;
let calls: GenerateTitleOptions[];
beforeEach(() => {
  env = createTestEnv();
  calls = [];
  env.harness.generateTitle = async (options) => {
    calls.push(options);
    return options.excerpt ? "Fixing the login bug" : "First title";
  };
});
afterEach(async () => {
  await env.cleanup();
});

const idle = (sid: string) => until(() => !env.service.listSessions().find((s) => s.id === sid)!.running);

async function chatWithTurns() {
  const chat = await newChat(env, { prompt: "set up the repo" });
  await idle(chat.sid);
  await env.service.prompt(chat.sid, { text: "now fix the login bug" });
  await idle(chat.sid);
  await until(() => env.store.getSession(chat.sid)!.title === "First title");
  return chat;
}

describe("generateSessionTitle", () => {
  it("names a single-tab chat from its conversation with the small model (tab + workspace)", async () => {
    env.harness.listModels = async () => [...FAKE_MODELS, { ...FAKE_MODELS[1]!, provider: "anthropic", id: "claude-haiku-4-5" } as ModelInfo];
    const chat = await chatWithTurns();
    const res = await env.service.generateSessionTitle(chat.sid);

    expect(res.title).toBe("Fixing the login bug");
    const call = calls.at(-1)!;
    expect(call.firstMessage).toBe("set up the repo");
    expect(call.excerpt).toContain("User: set up the repo");
    expect(call.excerpt).toContain("User: now fix the login bug");
    expect(call.excerpt).toContain("Assistant: You said: now fix the login bug");
    expect(call.excerpt).not.toContain("echo hi"); // tool calls/output skipped
    expect(call.model).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
    expect(res.session).toMatchObject({ title: "Fixing the login bug", titleSource: "user" });
    expect(env.store.getWorkspace(chat.wid)).toMatchObject({ title: "Fixing the login bug", titleSource: "user" });
  });

  it("uses the small model setting", async () => {
    env.service.updateSettings({ models: { smallModel: { provider: "fake", id: "fast" } } });
    const chat = await chatWithTurns();
    await env.service.generateSessionTitle(chat.sid);
    expect(calls.at(-1)!.model).toEqual({ provider: "fake", id: "fast" });
  });

  it("renames only the tab when the workspace has several", async () => {
    const chat = await chatWithTurns();
    const second = await env.service.createSession(chat.wid, { prompt: "other tab" });
    await idle(second.session.id);
    const workspaceTitle = env.store.getWorkspace(chat.wid)!.title;
    await env.service.generateSessionTitle(chat.sid);
    expect(env.store.getSession(chat.sid)).toMatchObject({ title: "Fixing the login bug", titleSource: "user" });
    expect(env.store.getWorkspace(chat.wid)!.title).toBe(workspaceTitle);
  });

  it("refuses an empty chat; the HTTP route returns the title", async () => {
    const empty = await newChat(env);
    await expect(env.service.generateSessionTitle(empty.sid)).rejects.toMatchObject({ status: 409 });
    const chat = await chatWithTurns();
    const { app } = createApp({ service: env.service });
    const res = await app.request(`/api/sessions/${chat.sid}/title/generate`, { method: "POST", headers: { host: "127.0.0.1:4317" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ title: "Fixing the login bug", session: { id: chat.sid, titleSource: "user" } });
  });
});
