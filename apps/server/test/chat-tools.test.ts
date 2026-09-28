/**
 * I-091: chat tools for agents (`/api/agents/chats/find|read|open`): token auth, results from the
 * ⌘K Ask pipeline + keyword hits, the caller's own chat left out, bounded output, the
 * `open_chat` push.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_ENV,
  CHAT_TOOLS_LIMITS,
  messageText,
  type FindChatsResponse,
  type OpenChatResponse,
  type ReadChatResponse,
} from "@glade/protocol";
import type { OpenSessionOptions, SessionTextMessage } from "../src/harness/types.js";
import { createAgentsRoutes } from "../src/http/agents.js";
import { lastMessages } from "../src/services/chat-tools.js";
import { SearchService } from "../src/services/search/search-service.js";
import { storeSummaries, storeTexts } from "../src/services/search/create.js";
import type { SmallModel } from "../src/services/search/types.js";
import { createTestEnv, flush, newChat, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
let opened: OpenSessionOptions[];
let search: SearchService;
let api: Hono;
/** Replies of the fake small model (null = unavailable). */
let pick: ((prompt: string) => string | null) | null;

/** Label of the candidate whose line mentions `needle`, from a finder prompt. */
function labelFor(prompt: string, needle: string): string | null {
  const line = prompt.split("\n").find((l) => /^c\d+:/.test(l) && l.includes(needle));
  return line ? line.slice(0, line.indexOf(":")) : null;
}

beforeEach(() => {
  env = createTestEnv();
  env.service.setServerUrl("http://127.0.0.1:4999");
  opened = [];
  const open = env.harness.openSession.bind(env.harness);
  env.harness.openSession = (options) => {
    opened.push(options);
    return open(options);
  };
  pick = null;
  const smallModel: SmallModel = async ({ prompt }) => (pick ? pick(prompt) : null);
  search = new SearchService({ app: env.service, texts: storeTexts(env.store), summaries: storeSummaries(env.store), smallModel, pollMs: 0 });
  api = createAgentsRoutes(env.service, search);
});
afterEach(async () => {
  search.dispose();
  await env.cleanup();
});

function tokenOf(sessionId: string): string {
  return opened.filter((o) => o.env?.[AGENT_ENV.sessionId] === sessionId).at(-1)!.env![AGENT_ENV.token]!;
}

async function post<T>(path: string, token: string | null, body: unknown): Promise<{ status: number; data: T }> {
  const res = await api.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as T };
}

/** A chat with one finished prompt (user message + "You said: …" reply). */
async function chat(prompt: string, title?: string) {
  const c = await newChat(env, { prompt });
  await until(() => env.service.listSessions().find((s) => s.id === c.sid)?.running === false && env.harness.sessions.get(env.store.getSession(c.sid)!.sessionRef!)!.transcript.messages.length >= 3);
  if (title) {
    await env.service.updateSession(c.sid, { title });
    await env.service.updateWorkspace(c.wid, { title });
  }
  return c;
}

describe("auth", () => {
  it("rejects missing and unknown tokens on every chat route", async () => {
    await chat("hello");
    for (const path of ["/chats/find", "/chats/read", "/chats/open"]) {
      expect((await post(path, null, { query: "x", id: "x" })).status).toBe(401);
      expect((await post(path, "nope", { query: "x", id: "x" })).status).toBe(401);
    }
  });

  it("validates bodies", async () => {
    const me = await chat("hello");
    const token = tokenOf(me.sid);
    expect((await post("/chats/find", token, {})).status).toBe(400);
    expect((await post("/chats/find", token, { query: "x", limit: "3" })).status).toBe(400);
    expect((await post("/chats/read", token, {})).status).toBe(400);
    expect((await post("/chats/open", token, { id: "missing" })).status).toBe(404);
  });
});

describe("find", () => {
  it("returns the model's pick with ids, title, summary fields and a keyword snippet; leaves out the caller", async () => {
    const button = await chat("add the new button to the toolbar", "Toolbar work");
    await chat("fix the login bug", "Login bug");
    // The caller's own chat mentions the same words (the user just asked about it).
    const me = await chat("find the chat where we added the new button");
    pick = (prompt) => {
      const labels = ["Toolbar work", "find the chat"].map((n) => labelFor(prompt, n)).filter(Boolean);
      return JSON.stringify({ matches: labels.map((id) => ({ id, reason: "talks about the button" })), confident: true });
    };
    const { status, data } = await post<FindChatsResponse>("/chats/find", tokenOf(me.sid), { query: "new button" });
    expect(status).toBe(200);
    expect(data.matches.map((m) => m.sessionId)).not.toContain(me.sid);
    expect(data.matches[0]).toMatchObject({
      sessionId: button.sid,
      workspaceId: button.wid,
      sessionKind: "main",
      title: "Toolbar work",
      project: null,
      reason: "talks about the button",
      matchedBy: "model",
    });
    expect(data.matches[0]!.snippet).toMatch(/new button/);
    expect(data.confident).toBe(true);
    expect(data.model).not.toBeNull();
  });

  it("includes the caller when asked", async () => {
    const me = await chat("remember the purple elephant");
    const { data } = await post<FindChatsResponse>("/chats/find", tokenOf(me.sid), { query: "purple elephant", includeSelf: true });
    expect(data.matches.map((m) => m.sessionId)).toContain(me.sid);
  });

  it("falls back to keyword ranking without a model, bounded by limit and snippet length", async () => {
    for (let i = 0; i < 4; i++) await chat(`refactor the parser ${"lorem ipsum ".repeat(60)} part ${i}`, `Chat ${i}`);
    const me = await chat("hello");
    const { data } = await post<FindChatsResponse>("/chats/find", tokenOf(me.sid), { query: "parser", limit: 2 });
    expect(data.model).toBeNull();
    expect(data.matches).toHaveLength(2);
    for (const m of data.matches) {
      expect(m.matchedBy).toBe("keyword");
      expect(m.snippet!.length).toBeLessThanOrEqual(CHAT_TOOLS_LIMITS.snippetChars);
    }
    const capped = await post<FindChatsResponse>("/chats/find", tokenOf(me.sid), { query: "parser", limit: 999 });
    expect(capped.data.matches.length).toBeLessThanOrEqual(CHAT_TOOLS_LIMITS.findMax);
  });
});

describe("read", () => {
  it("returns the chat and its last messages as text, without starting an agent", async () => {
    const other = await chat("first question");
    await env.service.prompt(other.sid, { text: "second question" });
    await until(() => env.harness.sessions.get(env.store.getSession(other.sid)!.sessionRef!)!.transcript.messages.length >= 6);
    const me = await chat("hello");
    // Stop the other chat's process: reading must work from persisted data only.
    const before = opened.length;
    const { status, data } = await post<ReadChatResponse>("/chats/read", tokenOf(me.sid), { id: other.sid, limit: 2 });
    expect(status).toBe(200);
    expect(opened.length).toBe(before);
    expect(data.chat).toMatchObject({ sessionId: other.sid, workspaceId: other.wid });
    expect(data.totalMessages).toBe(4); // tool-call-only assistant messages have no text
    expect(data.messages).toEqual([
      expect.objectContaining({ role: "user", text: "second question" }),
      expect.objectContaining({ role: "assistant", text: "You said: second question" }),
    ]);
  });

  it("accepts a workspace id (its active tab)", async () => {
    const other = await chat("via workspace");
    const me = await chat("hello");
    const { data } = await post<ReadChatResponse>("/chats/read", tokenOf(me.sid), { id: other.wid });
    expect(data.chat.sessionId).toBe(other.sid);
  });

  it("bounds each message and the total", () => {
    const long = (n: number) => ({ role: "user" as const, text: "x".repeat(n), timestamp: 0 });
    const out = lastMessages({ name: null, messages: [long(10), long(5000), long(100)] }, 10, 1000, 1200);
    // 100 + 1000 (cut) + 10 = 1110 ≤ 1200: all three, oldest first.
    expect(out.map((m) => m.text.length)).toEqual([10, 1000, 100]);
    expect(out[1]!.truncated).toBe(true);
    // Over the total: the oldest are dropped.
    expect(lastMessages({ name: null, messages: [long(500), long(1000), long(100)] }, 10, 1000, 1200).map((m) => m.text.length)).toEqual([1000, 100]);
    // At most `limit`.
    expect(lastMessages({ name: null, messages: [long(1), long(2), long(3)] }, 2, 1000, 1200).map((m) => m.text.length)).toEqual([2, 3]);
    // The newest message is always kept, even when alone over the total.
    expect(lastMessages({ name: null, messages: [long(10), long(5000)] }, 10, 3000, 100)).toHaveLength(1);
  });
});

describe("open", () => {
  it("pushes open_chat to the windows and reports how many", async () => {
    const other = await chat("open me");
    const me = await chat("hello");
    env.messages.length = 0;
    const { status, data } = await post<OpenChatResponse>("/chats/open", tokenOf(me.sid), { id: other.sid });
    expect(status).toBe(200);
    expect(data).toMatchObject({ chat: { sessionId: other.sid }, windows: 1 });
    await flush();
    expect(env.messages).toContainEqual({ type: "open_chat", workspaceId: other.wid, sessionId: other.sid, sessionKind: "main" });
  });
});
