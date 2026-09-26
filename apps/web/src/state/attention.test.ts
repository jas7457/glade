import { describe, expect, it } from "vitest";
import { alertChannel, alertText, attentionCount, chatAlertEvent, windowTitle, workingCount } from "./attention";
import { chats } from "./store";
import { makeChat } from "@/test/fixtures";

describe("chatAlertEvent", () => {
  const working = makeChat({ id: "a", status: "working", running: true });
  it("detects a finished run (working → unread)", () => {
    const next = makeChat({ id: "a", status: "unread", unread: true });
    expect(chatAlertEvent(working, next)).toEqual({ kind: "finished", chat: next, failed: false });
  });
  it("flags failed runs", () => {
    const next = makeChat({ id: "a", status: "unread", lastRunFailed: true });
    expect(chatAlertEvent(working, next)?.failed).toBe(true);
  });
  it("detects blocked", () => {
    const next = makeChat({ id: "a", status: "blocked", pendingInputs: 1 });
    expect(chatAlertEvent(working, next)?.kind).toBe("blocked");
  });
  it("ignores unchanged, new, and uninteresting transitions", () => {
    expect(chatAlertEvent(undefined, makeChat({ id: "a", status: "unread" }))).toBeNull();
    expect(chatAlertEvent(working, working)).toBeNull();
    expect(chatAlertEvent(working, makeChat({ id: "a", status: "idle" }))).toBeNull(); // finished on screen
    expect(chatAlertEvent(makeChat({ id: "a", status: "idle" }), makeChat({ id: "a", status: "unread" }))).toBeNull();
  });
});

describe("alertChannel", () => {
  const base = { chatId: "a", currentChatId: "b", documentHidden: false, windowFocused: true };
  it("uses a system notification when the window is hidden or unfocused", () => {
    expect(alertChannel({ ...base, documentHidden: true })).toBe("system");
    expect(alertChannel({ ...base, windowFocused: false, currentChatId: "a" })).toBe("system");
  });
  it("uses a toast for background chats while focused", () => {
    expect(alertChannel(base)).toBe("toast");
  });
  it("stays quiet for the chat on screen", () => {
    expect(alertChannel({ ...base, currentChatId: "a" })).toBeNull();
  });
});

describe("alertText", () => {
  it("describes each event", () => {
    const chat = makeChat({ id: "a", title: "Fix bug" });
    expect(alertText({ kind: "blocked", chat, failed: false }).title).toBe("Fix bug needs your input");
    expect(alertText({ kind: "finished", chat, failed: true }).body).toBe("The last run failed.");
  });
});

describe("counts + window title", () => {
  it("counts attention and working chats", () => {
    chats.value = [
      makeChat({ id: "1", status: "unread" }),
      makeChat({ id: "2", status: "blocked" }),
      makeChat({ id: "3", status: "working" }),
      makeChat({ id: "4", status: "idle" }),
    ];
    expect(attentionCount.value).toBe(2);
    expect(workingCount.value).toBe(2);
  });
  it("formats the title", () => {
    expect(windowTitle(0)).toBe("pi-ui");
    expect(windowTitle(3)).toBe("(3) pi-ui");
    expect(windowTitle(1, "Fix bug")).toBe("(1) Fix bug — pi-ui");
  });
});
