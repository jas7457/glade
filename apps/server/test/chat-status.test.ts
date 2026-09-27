import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ChatStatus, SessionSummary } from "@glade/protocol";
import type { FakeSession } from "../src/harness/fake/fake-harness.js";
import { createTestEnv, flush, newChat, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
let chatId: string;
let workspaceId: string;
let session: FakeSession;

beforeEach(async () => {
  env = createTestEnv();
  ({ sid: chatId, wid: workspaceId } = await newChat(env));
  session = [...env.harness.openSessions][0]!;
  env.messages.length = 0;
});
afterEach(async () => {
  await env.cleanup();
});

function upserts(): SessionSummary[] {
  return env.messages.flatMap((m) => (m.type === "session_upsert" && m.session.id === chatId ? [m.session] : []));
}
function lastStatus(): ChatStatus | undefined {
  return upserts().at(-1)?.status;
}
function current(): SessionSummary {
  return env.service.listSessions().find((c) => c.id === chatId)!;
}
function emit(...events: AgentEvent[]): void {
  for (const e of events) session.emit(e);
}
const errorMessage = (stopReason: "error" | "aborted"): AgentEvent => ({
  type: "message_end",
  message: { id: `a-${stopReason}`, role: "assistant", content: [], timestamp: 1, stopReason },
});

describe("chat status", () => {
  it("idle → working → blocked → working → unread when not viewed", () => {
    expect(current()).toMatchObject({ status: "idle", running: false, pendingInputs: 0 });

    emit({ type: "run_start" });
    expect(lastStatus()).toBe("working");

    emit({ type: "ui_request", request: { id: "q", kind: "confirm", title: "Run?" } });
    expect(lastStatus()).toBe("blocked");
    expect(upserts().at(-1)?.pendingInputs).toBe(1);
    expect(current().unread).toBe(false); // blocked alone doesn't mark unread

    env.service.respondToUi(chatId, { id: "q", confirmed: true });
    expect(lastStatus()).toBe("working");
    expect(upserts().at(-1)?.pendingInputs).toBe(0);

    emit({ type: "run_end" });
    expect(upserts().at(-1)).toMatchObject({ status: "unread", unread: true, running: false });
  });

  it("run_end while viewed → idle", () => {
    env.service.setViewing(chatId, true);
    emit({ type: "run_start" }, { type: "run_end" });
    expect(upserts().map((c) => c.status)).toEqual(["working", "idle"]);
  });

  it("setViewing clears unread and broadcasts", () => {
    emit({ type: "run_start" }, { type: "run_end" });
    expect(lastStatus()).toBe("unread");
    env.service.setViewing(chatId, true);
    expect(upserts().at(-1)).toMatchObject({ status: "idle", unread: false });
  });

  it("ui_request_closed from the agent unblocks", () => {
    emit({ type: "run_start" }, { type: "ui_request", request: { id: "q", kind: "input", title: "Name?" } });
    expect(lastStatus()).toBe("blocked");
    emit({ type: "ui_request_closed", id: "q" });
    expect(lastStatus()).toBe("working");
  });

  it("dialogs with a timeout expire and unblock", async () => {
    emit({ type: "run_start" }, { type: "ui_request", request: { id: "q", kind: "select", title: "Pick", options: ["a"], timeoutMs: 20 } });
    expect(lastStatus()).toBe("blocked");
    await until(() => lastStatus() === "working");
    expect(env.messages).toContainEqual({ type: "session_event", sessionId: chatId, workspaceId, event: { type: "ui_request_closed", id: "q" } });
    expect(current().pendingInputs).toBe(0);
  });

  it("answered dialogs don't fire their timeout later", async () => {
    emit({ type: "run_start" }, { type: "ui_request", request: { id: "q", kind: "confirm", title: "?", timeoutMs: 10 } });
    env.service.respondToUi(chatId, { id: "q", confirmed: false });
    const closedCount = () =>
      env.messages.filter((m) => m.type === "session_event" && m.event.type === "ui_request_closed").length;
    expect(closedCount()).toBe(1);
    await flush(30);
    expect(closedCount()).toBe(1);
  });

  it("lastRunFailed: set on error stopReason, cleared on next run_start, not set on abort", () => {
    emit({ type: "run_start" }, errorMessage("error"), { type: "run_end" });
    expect(current().lastRunFailed).toBe(true);
    expect(env.store.getSession(chatId)?.lastRunFailed).toBe(true); // persisted

    emit({ type: "run_start" });
    expect(current().lastRunFailed).toBe(false);
    emit(errorMessage("aborted"), { type: "run_end" });
    expect(current().lastRunFailed).toBe(false);
  });

  it("a crash sets lastRunFailed and unread (not viewed)", () => {
    emit({ type: "run_start" });
    session.crash("died");
    expect(upserts().at(-1)).toMatchObject({ lastRunFailed: true, unread: true, status: "unread", running: false });
  });

  it("a crash while viewed doesn't mark unread", () => {
    env.service.setViewing(chatId, true);
    emit({ type: "run_start" }, { type: "ui_request", request: { id: "q", kind: "confirm", title: "?" } });
    session.crash("died");
    expect(upserts().at(-1)).toMatchObject({ lastRunFailed: true, unread: false, status: "idle", pendingInputs: 0 });
  });
});
