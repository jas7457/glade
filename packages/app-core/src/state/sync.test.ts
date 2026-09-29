/**
 * I-122: the client side of sequenced sync. `SyncController` (pure: a recording target) for the
 * duplicate/gap rule, snapshots, the list check and resubscribing; `startSync` with a fake socket
 * for "a reconnect resumes from the last seq without reloading everything".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifySeq,
  defaultSessionState,
  defaultSettings,
  type ClientMessage,
  type ServerMessage,
  type ShellSnapshot,
} from "@glade/protocol";
import { h } from "preact";
import { render } from "@testing-library/preact";
import { makeSession, makeWorkspace } from "@glade/app-core/test/fixtures";

// A fake socket for the startSync test (the controller tests don't use it).
const fake = vi.hoisted(() => {
  const handlers = { message: [] as Array<(m: unknown) => void>, open: [] as Array<() => void>, close: [] as Array<() => void> };
  return {
    handlers,
    sent: [] as unknown[],
    socket: {
      send: (m: unknown) => fake.sent.push(m),
      watch: () => () => {},
      onMessage: (h: (m: unknown) => void) => handlers.message.push(h),
      onOpen: (h: () => void) => handlers.open.push(h),
      onClose: (h: () => void) => handlers.close.push(h),
      connect: () => {},
    },
  };
});
vi.mock("@glade/app-core/lib/socket", () => ({ socket: fake.socket }));
vi.mock("@glade/app-core/lib/api", () => ({
  api: {
    listProjects: vi.fn(async () => []),
    listWorkspaces: vi.fn(async () => []),
    listSessions: vi.fn(async () => []),
    getSettings: vi.fn(async () => defaultSettings()),
    listModels: vi.fn(async () => []),
    getSession: vi.fn(),
  },
}));
vi.mock("@glade/app-core/lib/api-folder", () => ({ getHarnessDefaults: vi.fn(async () => null) }));
vi.mock("./harnesses", async () => ({ harnesses: (await import("@preact/signals")).signal(null), loadHarnesses: vi.fn(async () => {}) }));

const { SyncController, startSync, syncStatus } = await import("./sync");
const { api } = await import("@glade/app-core/lib/api");
const store = await import("./store");
const chat = await import("./chat-session");

/** A mounted chat (loads it and keeps it subscribed until unmounted). */
function mountChat(id: string): () => void {
  const Probe = () => (chat.useChatSession(id, { markViewing: false }), null);
  const view = render(h(Probe, {}));
  return () => view.unmount();
}

function recorder() {
  const log: Array<[string, ...unknown[]]> = [];
  const sent: ClientMessage[] = [];
  let missing = false;
  let patchFits = true;
  const target = {
    send: (m: ClientMessage) => sent.push(m),
    applyShell: (m: ServerMessage) => log.push(["shell", m.type, m.seq]),
    applyShellSnapshot: (s: ShellSnapshot) => log.push(["shellSnapshot", s.workspaces.length]),
    applyShellCheck: () => missing,
    applySessionEvent: (id: string, e: { type: string }) => log.push(["event", id, e.type]),
    applySessionSnapshot: (id: string) => log.push(["sessionSnapshot", id]),
    applySessionLive: (id: string) => log.push(["sessionLive", id]),
    applyTranscriptPatch: (id: string) => (log.push(["patch", id]), patchFits),
    applySessionError: (id: string, error: string) => log.push(["error", id, error]),
    legacyReload: vi.fn(),
  };
  return {
    target,
    log,
    sent,
    setMissing: (v: boolean) => (missing = v),
    setPatchFits: (v: boolean) => (patchFits = v),
  };
}

const hello: ServerMessage = { type: "hello", version: "t", protocol: 2 };
const shellSnap = (seq: number): ServerMessage => ({
  type: "snapshot",
  scope: "shell",
  seq,
  shell: { projects: [], workspaces: [], sessions: [], settings: defaultSettings() },
});
const shellLive = (seq: number): ServerMessage => ({ type: "live", scope: "shell", seq, check: { projects: [], workspaces: [], sessions: [] } });
const upsert = (seq: number, prev?: number): ServerMessage => ({ type: "workspace_upsert", workspace: makeWorkspace({ id: "w" }), seq, ...(prev !== undefined ? { prev } : {}) });
const live = { state: defaultSessionState(), pendingUiRequests: [] };
const delta = (seq: number): ServerMessage => ({
  type: "session_event",
  sessionId: "s",
  workspaceId: "w",
  event: { type: "block_delta", messageId: "m", index: 0, delta: "x" },
  seq,
});

describe("classifySeq", () => {
  it("drops duplicates and stale pushes, applies the next one, flags gaps", () => {
    expect(classifySeq(10, { seq: 10, prev: 9 })).toBe("drop"); // duplicate
    expect(classifySeq(10, { seq: 12, prev: 10 })).toBe("apply");
    expect(classifySeq(10, { seq: 12, prev: 8 })).toBe("apply"); // overlaps what we have
    expect(classifySeq(10, { seq: 14, prev: 12 })).toBe("gap");
    expect(classifySeq(10, { seq: 10 })).toBe("apply"); // ephemeral, based on what we have
    expect(classifySeq(10, { seq: 9 })).toBe("drop"); // stale
    expect(classifySeq(10, { seq: 11 })).toBe("gap");
    expect(classifySeq(null, { seq: 3, prev: 2 })).toBe("drop"); // before the snapshot
    expect(classifySeq(null, {})).toBe("apply"); // untagged
  });
});

describe("SyncController", () => {
  it("subscribes after hello, then applies pushes once, in order", () => {
    const r = recorder();
    const sync = new SyncController(r.target);
    sync.onOpen();
    sync.receive(hello);
    expect(r.sent).toEqual([{ type: "subscribe", scope: "shell" }]);
    sync.receive({ type: "batch", messages: [shellSnap(10), shellLive(10), upsert(12, 10), upsert(12, 10), upsert(11, 10)] });
    expect(r.log).toEqual([
      ["shellSnapshot", 0],
      ["shell", "workspace_upsert", 12],
    ]);
    expect(sync.lastSeq("shell")).toBe(12); // the duplicate and the older one were dropped
    sync.receive(upsert(15, 12));
    expect(sync.lastSeq("shell")).toBe(15);
  });

  it("marks replayed shell pushes as not live, pushes after `live` as live (I-135)", () => {
    const r = recorder();
    const flags: boolean[] = [];
    const sync = new SyncController({ ...r.target, applyShell: (_m: ServerMessage, isLive: boolean) => flags.push(isLive) });
    sync.onOpen();
    sync.receive(hello);
    sync.receive({ type: "batch", messages: [shellSnap(10), upsert(11, 10), shellLive(11), upsert(12, 11)] });
    expect(flags).toEqual([false, true]);
    // Reconnect: the replay is not live again until the next `live`.
    sync.onClose();
    sync.onOpen();
    sync.receive(hello);
    sync.receive({ type: "batch", messages: [upsert(13, 12), shellLive(13), upsert(14, 13)] });
    expect(flags).toEqual([false, true, false, true]);
  });

  it("on a gap, subscribes again from the last seq and ignores the rest until the replay", () => {
    const r = recorder();
    const sync = new SyncController(r.target);
    sync.onOpen();
    sync.receive(hello);
    sync.receive({ type: "batch", messages: [shellSnap(10), shellLive(10)] });
    r.sent.length = 0;
    sync.receive(upsert(20, 18)); // missed 11..18
    sync.receive(upsert(21, 20));
    expect(r.sent).toEqual([{ type: "subscribe", scope: "shell", afterSeq: 10 }]);
    sync.receive({ type: "batch", messages: [upsert(20, 10), shellLive(21)] });
    expect(r.log.filter((l) => l[0] === "shell")).toEqual([["shell", "workspace_upsert", 20]]);
    expect(sync.lastSeq("shell")).toBe(21);
  });

  it("asks for a snapshot when the list check finds ids it doesn't have", () => {
    const r = recorder();
    const sync = new SyncController(r.target);
    sync.onOpen();
    sync.receive(hello);
    sync.receive(shellSnap(5));
    r.setMissing(true);
    r.sent.length = 0;
    sync.receive(shellLive(5));
    expect(r.sent).toEqual([{ type: "subscribe", scope: "shell" }]);
  });

  it("session scope: deltas based on the last seq apply, markers advance it, a misfit patch restarts", () => {
    const r = recorder();
    const sync = new SyncController(r.target);
    sync.onOpen();
    sync.receive(hello);
    const release = sync.retain("s");
    expect(r.sent.at(-1)).toEqual({ type: "subscribe", scope: "session", sessionId: "s" });
    sync.receive({ type: "snapshot", scope: "session", sessionId: "s", seq: 7, page: { messages: [], toolResults: {}, start: 0, total: 0 }, ...live });
    sync.receive({ type: "live", scope: "session", sessionId: "s", seq: 7, ...live });
    sync.receive(delta(7));
    sync.receive(delta(6)); // from before the snapshot: stale
    sync.receive({ type: "session_sync", sessionId: "s", seq: 9, prev: 7 });
    sync.receive(delta(9));
    sync.receive({ type: "session_sync", sessionId: "s", seq: 9, prev: 7 }); // duplicate
    expect(r.log.filter((l) => l[0] === "event").length).toBe(2);
    expect(sync.lastSeq("s")).toBe(9);

    r.setPatchFits(false);
    sync.receive({ type: "transcript_patch", sessionId: "s", messages: [], toolResults: [], seq: 11, prev: 9 });
    expect(r.sent.at(-1)).toEqual({ type: "subscribe", scope: "session", sessionId: "s" });

    // Hidden: unsubscribed, but its seq is kept for the next time it's shown.
    release();
    expect(r.sent.at(-1)).toEqual({ type: "unsubscribe", scope: "session", sessionId: "s" });
    sync.receive(delta(11));
    expect(r.log.filter((l) => l[0] === "event").length).toBe(2);
  });

  it("a reconnect resubscribes every scope from its last seq (no reload)", () => {
    const r = recorder();
    const sync = new SyncController(r.target);
    sync.onOpen();
    sync.receive(hello);
    sync.retain("s");
    sync.receive({ type: "batch", messages: [shellSnap(10), shellLive(10), { type: "live", scope: "session", sessionId: "s", seq: 10, ...live }] });
    sync.receive(upsert(13, 10));
    sync.onClose();
    r.sent.length = 0;
    sync.onOpen();
    sync.receive(hello);
    expect(r.sent).toEqual([
      { type: "subscribe", scope: "shell", afterSeq: 13 },
      { type: "subscribe", scope: "session", sessionId: "s", afterSeq: 10 },
    ]);
    expect(r.target.legacyReload).not.toHaveBeenCalled();
  });

  it("loads a chat from a snapshot when the connection is live, asking once (I-169)", () => {
    const r = recorder();
    const sync = new SyncController(r.target);
    expect(sync.snapshot("s")).toBe(false); // not connected: over HTTP
    sync.onOpen();
    sync.receive(hello);
    r.sent.length = 0;
    // Opening a chat: the load asks for a snapshot, then mounting subscribes (once).
    expect(sync.snapshot("s")).toBe(true);
    expect(r.sent).toEqual([]);
    sync.retain("s");
    expect(r.sent).toEqual([{ type: "subscribe", scope: "session", sessionId: "s" }]);
    expect(sync.snapshot("s")).toBe(true);
    expect(r.sent).toHaveLength(1);
    sync.receive({ type: "snapshot", scope: "session", sessionId: "s", seq: 4, page: { messages: [], toolResults: {}, start: 10, total: 30 }, ...live });
    sync.receive({ type: "live", scope: "session", sessionId: "s", seq: 4, ...live });
    // A reload of a shown chat: a fresh snapshot.
    expect(sync.snapshot("s")).toBe(true);
    expect(r.sent.at(-1)).toEqual({ type: "subscribe", scope: "session", sessionId: "s" });
  });

  it("an older server (no sequenced sync) loads chats over HTTP", () => {
    const r = recorder();
    const sync = new SyncController(r.target);
    sync.onOpen();
    sync.receive({ type: "hello", version: "old" });
    expect(sync.snapshot("s")).toBe(false);
  });

  it("falls back to a full reload with a server that has no sequenced sync", () => {
    const r = recorder();
    const sync = new SyncController(r.target);
    sync.onOpen();
    sync.receive({ type: "hello", version: "old" });
    sync.onClose();
    sync.onOpen();
    sync.receive({ type: "hello", version: "old" });
    expect(r.sent).toEqual([]);
    expect(r.target.legacyReload).toHaveBeenCalledTimes(1);
  });
});

describe("startSync (I-122)", () => {
  beforeEach(() => {
    store.resetShellSync();
  });

  it("a reconnect catches up from the last seq instead of reloading everything", async () => {
    startSync();
    const emit = (m: ServerMessage) => fake.handlers.message.forEach((h) => h(m));
    const open = () => fake.handlers.open.forEach((h) => h());
    const close = () => fake.handlers.close.forEach((h) => h());
    await vi.waitFor(() => expect(api.listProjects).toHaveBeenCalledTimes(1)); // first paint

    open();
    emit(hello);
    expect(fake.sent).toEqual([{ type: "subscribe", scope: "shell" }]);
    const w = makeWorkspace({ id: "w1" });
    const s = makeSession({ id: "s1", workspaceId: "w1" });
    emit({
      type: "batch",
      messages: [
        { type: "snapshot", scope: "shell", seq: 5, shell: { projects: [], workspaces: [w], sessions: [s], settings: defaultSettings() } },
        { type: "live", scope: "shell", seq: 5, check: { projects: [], workspaces: ["w1"], sessions: ["s1"] } },
      ],
    });
    expect(syncStatus.value).toBe("live");
    expect(store.workspaces.value.map((x) => x.id)).toEqual(["w1"]);

    // The connection drops; meanwhile w1 was renamed and a stale row lingers here.
    close();
    expect(syncStatus.value).toBe("offline");
    store.workspaces.value = [...store.workspaces.value, makeWorkspace({ id: "gone" })];
    fake.sent.length = 0;
    open();
    emit(hello);
    expect(fake.sent).toEqual([{ type: "subscribe", scope: "shell", afterSeq: 5 }]);
    expect(syncStatus.value).toBe("catching-up");
    emit({
      type: "batch",
      messages: [
        { type: "workspace_upsert", workspace: { ...w, title: "Renamed" }, seq: 8, prev: 5 },
        { type: "live", scope: "shell", seq: 9, check: { projects: [], workspaces: ["w1"], sessions: ["s1"] } },
      ],
    });
    expect(syncStatus.value).toBe("live");
    expect(store.workspaces.value.map((x) => [x.id, x.title])).toEqual([["w1", "Renamed"]]);
    // No full reload: the lists were fetched once, at startup.
    expect(api.listProjects).toHaveBeenCalledTimes(1);
    expect(api.listWorkspaces).toHaveBeenCalledTimes(1);
  });

  it("opens a chat with the newest turns from a snapshot, not the whole transcript over HTTP (I-169)", async () => {
    startSync();
    const emit = (m: ServerMessage) => fake.handlers.message.forEach((h) => h(m));
    fake.handlers.open.forEach((h) => h());
    emit(hello);
    fake.sent.length = 0;
    const release = mountChat("s9");
    expect(api.getSession).not.toHaveBeenCalled();
    expect(chat.getChatSession("s9").status.value).toBe("loading");
    expect(fake.sent).toEqual([{ type: "subscribe", scope: "session", sessionId: "s9" }]);
    const message = { id: "m60", role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: 1 };
    emit({ type: "snapshot", scope: "session", sessionId: "s9", seq: 3, page: { messages: [message], toolResults: {}, start: 60, total: 61 }, ...live });
    emit({ type: "live", scope: "session", sessionId: "s9", seq: 3, ...live });
    const loaded = chat.getChatSession("s9");
    expect(loaded.status.value).toBe("ready");
    expect(loaded.start.value).toBe(60);
    expect(loaded.transcript.value.messages.map((m) => m.id)).toEqual(["m60"]);
    release();
  });
});
