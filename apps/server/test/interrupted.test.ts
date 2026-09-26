/**
 * I-025: runs cut off by a quit/crash are flagged `interrupted` (also after a restart).
 */
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ChatSummary } from "@pi-ui/protocol";
import { FakeHarness, type FakeSession } from "../src/harness/fake/fake-harness.js";
import { AppService } from "../src/services/app-service.js";
import { Store } from "../src/store/store.js";
import { createTestEnv, flush, type TestEnv } from "./helpers.js";

let env: TestEnv;
let chatId: string;
let session: FakeSession;

beforeEach(async () => {
  env = createTestEnv();
  chatId = (await env.service.createChat({ projectId: null })).chat.id;
  session = [...env.harness.openSessions][0]!;
  env.messages.length = 0;
});
afterEach(async () => {
  await env.cleanup();
});

const emit = (...events: AgentEvent[]) => events.forEach((e) => session.emit(e));
const stored = () => env.store.getChat(chatId)!;

describe("interrupted runs", () => {
  it("runInProgress is persisted between run_start and run_end", () => {
    emit({ type: "run_start" });
    expect(stored().runInProgress).toBe(true);
    emit({ type: "run_end" });
    expect(stored().runInProgress).toBe(false);
    expect(stored().interrupted).toBeUndefined();
  });

  it("a user abort isn't an interruption", async () => {
    emit({ type: "run_start" });
    await env.service.abort(chatId);
    expect(stored()).toMatchObject({ runInProgress: false });
    expect(stored().interrupted).toBeUndefined();
  });

  it("a restart marks chats that were mid-run as interrupted, failed and unread", async () => {
    emit({ type: "run_start" });
    env.store.flush();

    // Simulate a restart: a fresh store + service over the same data dir.
    const store = new Store(join(env.dir, "data"), 0);
    const service = new AppService({ store, harness: new FakeHarness(), scratchDir: join(env.dir, "scratch") });
    try {
      const chat = service.listChats().find((c) => c.id === chatId)!;
      expect(chat).toMatchObject({ runInProgress: false, interrupted: true, unread: true, lastRunFailed: true, status: "unread" });
      expect(new Store(join(env.dir, "data"), 0).getChat(chatId)?.interrupted).toBe(true); // persisted

      // Dismiss.
      const dismissed = await service.updateChat(chatId, { interrupted: false });
      expect(dismissed.interrupted).toBeUndefined();
    } finally {
      await service.dispose();
    }
  });

  it("an agent exiting mid-run marks the chat interrupted (and broadcasts run_end)", () => {
    emit({ type: "run_start" });
    session.crash("killed");
    expect(stored()).toMatchObject({ interrupted: true, runInProgress: false, lastRunFailed: true, unread: true });
    expect(env.messages).toContainEqual({ type: "chat_event", chatId, event: { type: "run_end" } });
    const last = env.messages.filter((m): m is { type: "chat_upsert"; chat: ChatSummary } => m.type === "chat_upsert").at(-1);
    expect(last?.chat.interrupted).toBe(true);
  });

  it("a crash while idle isn't an interruption", () => {
    session.crash("died");
    expect(stored().interrupted).toBeUndefined();
    expect(stored().lastRunFailed).toBe(true);
  });

  it("any new prompt clears interrupted", async () => {
    emit({ type: "run_start" });
    session.crash("killed");
    expect(stored().interrupted).toBe(true);
    await env.service.prompt(chatId, { text: "Continue where you left off." });
    expect(stored().interrupted).toBeUndefined();
    await flush();
    expect(stored()).toMatchObject({ runInProgress: false, lastRunFailed: false });
  });

  it("PATCH only accepts interrupted: false", async () => {
    const { createApp } = await import("../src/http/app.js");
    const { app } = createApp({ service: env.service });
    const patch = (body: unknown) =>
      app.request(`/api/chats/${chatId}`, {
        method: "PATCH",
        headers: { host: "127.0.0.1:4317", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await patch({ interrupted: true })).status).toBe(400);
    emit({ type: "run_start" });
    session.crash("killed");
    const res = await patch({ interrupted: false });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ChatSummary).interrupted).toBeUndefined();
  });
});
