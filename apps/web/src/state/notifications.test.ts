/**
 * I-135: system notifications. Transition detection (each kind, sub-agents excluded), the
 * background-only gate, live pushes vs replays through the real sync wiring, click routing to
 * remote chats, and the per-device settings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signal } from "@preact/signals";
import type { ServerMessage, SessionSummary } from "@glade/protocol";
import { makeSession, makeWorkspace } from "@/test/fixtures";
import type { NotificationTarget, NotifierBackend, SystemNotification } from "@/lib/system-notifications";
import type { EnvHandle } from "./env-registry";

vi.mock("@/lib/socket", () => ({ socket: { send() {}, watch: () => () => {}, onMessage() {}, onOpen() {}, onClose() {}, connect() {} } }));
vi.mock("./harnesses", async () => ({ harnesses: (await import("@preact/signals")).signal(null), loadHarnesses: vi.fn(async () => {}) }));

const n = await import("./notifications");
const { attachSync } = await import("./sync");
const store = await import("./store");
const registry = await import("./env-registry");
const { openChatRequest } = await import("./open-chat");
const { openChatPath } = await import("@/app/openChatRequests");
const { currentWorkspaceId } = await import("./attention");

const base = (o: Partial<SessionSummary> = {}) => makeSession({ id: "s1", workspaceId: "w1", ...o });
const running = base({ running: true, status: "working" });

function fakeBackend(permission: "granted" | "default" | "denied" = "granted") {
  const shown: SystemNotification[] = [];
  let click: ((t: NotificationTarget) => void) | null = null;
  const backend: NotifierBackend = {
    permission: vi.fn(async () => permission),
    request: vi.fn(async () => "granted" as const),
    show: vi.fn(async (x: SystemNotification) => void shown.push(x)),
    onClick: (h) => ((click = h), () => (click = null)),
  };
  return { backend, shown, click: (t: NotificationTarget) => click?.(t) };
}

function fakeSocket() {
  const handlers = { message: [] as Array<(m: ServerMessage) => void>, open: [] as Array<() => void>, close: [] as Array<() => void> };
  return {
    handlers,
    socket: {
      send() {},
      onMessage: (h: (m: ServerMessage) => void) => (handlers.message.push(h), () => {}),
      onOpen: (h: () => void) => (handlers.open.push(h), () => {}),
      onClose: (h: () => void) => (handlers.close.push(h), () => {}),
    },
    receive: (m: ServerMessage) => handlers.message.forEach((h) => h(m)),
    open: () => handlers.open.forEach((h) => h()),
    close: () => handlers.close.forEach((h) => h()),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  n.reloadNotificationPrefs();
  store.sessions.value = [];
  store.workspaces.value = [];
  currentWorkspaceId.value = null;
  vi.spyOn(document, "hasFocus").mockReturnValue(false); // Glade in the background
});
afterEach(() => vi.restoreAllMocks());

describe("detectNotification", () => {
  it("detects each kind", () => {
    expect(n.detectNotification(running, base({ pendingInputs: 1, running: true, status: "blocked" }))).toBe("needs-input");
    expect(n.detectNotification(running, base({ unread: true, status: "unread" }))).toBe("finished");
    expect(n.detectNotification(running, base({ status: "idle" }))).toBe("finished"); // viewed while in the background
    expect(n.detectNotification(running, base({ lastRunFailed: true, unread: true, status: "unread" }))).toBe("failed");
    expect(n.detectNotification(base(), base({ interrupted: true, lastRunFailed: true }))).toBe("failed");
  });
  it("ignores non-transitions, unknown sessions and sub-agents", () => {
    const done = base({ unread: true, status: "unread" });
    expect(n.detectNotification(done, done)).toBeNull(); // the same push twice
    expect(n.detectNotification(undefined, done)).toBeNull();
    expect(n.detectNotification(base({ pendingInputs: 1, running: true }), running)).toBeNull(); // answered
    const sub = { kind: "subagent" as const, parentSessionId: "p" };
    expect(n.detectNotification(base({ ...sub, running: true }), base({ ...sub, unread: true }))).toBeNull();
    expect(n.detectNotification(base({ ...sub, running: true }), base({ ...sub, running: true, pendingInputs: 1 }))).toBeNull();
    // An error mid-run only notifies once the run ends.
    expect(n.detectNotification(running, base({ running: true, lastRunFailed: true }))).toBeNull();
  });
});

describe("shouldNotify", () => {
  const prefs = n.DEFAULT_NOTIFICATION_PREFS;
  it("only in the background by default", () => {
    expect(n.shouldNotify("finished", prefs, false, true)).toBe(true);
    expect(n.shouldNotify("finished", prefs, true, false)).toBe(false);
  });
  it("in front when allowed, except for the chat on screen", () => {
    const always = { ...prefs, backgroundOnly: false };
    expect(n.shouldNotify("finished", always, true, false)).toBe(true);
    expect(n.shouldNotify("finished", always, true, true)).toBe(false);
  });
  it("respects each kind's switch", () => {
    expect(n.shouldNotify("needs-input", { ...prefs, needsInput: false }, false, false)).toBe(false);
    expect(n.shouldNotify("failed", { ...prefs, failed: false }, false, false)).toBe(false);
    expect(n.shouldNotify("finished", { ...prefs, finished: false }, false, false)).toBe(false);
  });
});

describe("live pushes from a remote environment", () => {
  beforeEach(() => {
    registry.localEnvironmentId.value = "L";
    registry.connections.value = [{ id: "B", name: signal("Mac Studio") } as unknown as EnvHandle];
  });
  afterEach(() => {
    registry.localEnvironmentId.value = null;
    registry.connections.value = [];
  });

  it("notifies for live transitions only, never for the replay after a reconnect", async () => {
    const fake = fakeBackend();
    n.startNotifications(fake.backend);
    await flush();
    const s = fakeSocket();
    const off = attachSync(s.socket, "B");
    const upsert = (session: SessionSummary, seq: number): ServerMessage => ({ type: "session_upsert", session, seq, prev: seq - 1 });
    const snapshot = (seq: number): ServerMessage => ({
      type: "snapshot",
      scope: "shell",
      seq,
      shell: { projects: [], workspaces: [makeWorkspace({ id: "w1", title: "Fix login" })], sessions: [running], settings: store.settings.value },
    });
    const live = (seq: number): ServerMessage => ({ type: "live", scope: "shell", seq, check: { projects: [], workspaces: ["w1"], sessions: ["s1"] } });
    s.open();
    s.receive({ type: "hello", version: "t", protocol: 2 });
    // Replayed before `live`: no banner even though it's a transition.
    s.receive({ type: "batch", messages: [snapshot(10), upsert(base({ unread: true, status: "unread" }), 11), upsert(running, 12), live(12)] });
    await flush();
    expect(fake.shown).toEqual([]);

    s.receive(upsert(base({ running: true, pendingInputs: 1, status: "blocked", attentionLine: "Delete the branch?" }), 13));
    await flush();
    expect(fake.shown).toEqual([
      {
        tag: "glade:B:s1:needs-input",
        title: "Fix login",
        subtitle: "On Mac Studio",
        body: "Delete the branch?",
        target: { envId: "B", workspaceId: "w1", sessionId: "s1" },
      },
    ]);

    // Reconnect: the replayed "finished" push isn't live.
    s.close();
    s.open();
    s.receive({ type: "hello", version: "t", protocol: 2 });
    s.receive({ type: "batch", messages: [upsert(base({ unread: true, status: "unread" }), 14), live(14)] });
    await flush();
    expect(fake.shown).toHaveLength(1);
    off();
  });

  it("skips in front (background only) and sub-agents", async () => {
    const fake = fakeBackend();
    n.startNotifications(fake.backend);
    await flush();
    const obs = (prev: SessionSummary, next: SessionSummary) => n.observeSessionUpsert(prev, next, "B");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    obs(running, base({ unread: true, lastActivityAt: 1 }));
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const sub = { kind: "subagent" as const, parentSessionId: "p" };
    obs(base({ ...sub, running: true }), base({ ...sub, unread: true, lastActivityAt: 2 }));
    await flush();
    expect(fake.shown).toEqual([]);
    obs(running, base({ unread: true, lastActivityAt: 3 }));
    await flush();
    expect(fake.shown.map((x) => x.body)).toEqual(["Finished"]);
  });

  it("a click opens the chat on its environment", async () => {
    const fake = fakeBackend();
    n.startNotifications(fake.backend);
    store.workspaces.value = [makeWorkspace({ id: "w1", environmentId: "B" })];
    fake.click({ envId: "B", workspaceId: "w1", sessionId: "s1" });
    expect(openChatRequest.value).toEqual({ workspaceId: "w1", sessionId: "s1", sessionKind: "main" });
    expect(openChatPath(openChatRequest.value!, store.workspacesById.value)).toBe("/e/B/chats/w1?tab=s1");
    openChatRequest.value = null;
  });

  it("doesn't show the same transition twice across windows", async () => {
    const fake = fakeBackend();
    n.startNotifications(fake.backend);
    await flush();
    const next = base({ unread: true, lastActivityAt: 42 });
    localStorage.setItem("glade.notify.claim:glade:B:s1:finished:42", `other-window@${Date.now()}`);
    n.observeSessionUpsert(running, next, "B");
    await flush();
    expect(fake.shown).toEqual([]);
  });
});

describe("settings", () => {
  it("are stored on this device", () => {
    expect(n.notificationPrefs.value).toEqual({ needsInput: true, finished: true, failed: true, backgroundOnly: true });
    n.updateNotificationPrefs({ finished: false, backgroundOnly: false });
    expect(JSON.parse(localStorage.getItem("glade.notifications")!)).toMatchObject({ finished: false, backgroundOnly: false });
    n.notificationPrefs.value = n.DEFAULT_NOTIFICATION_PREFS;
    n.reloadNotificationPrefs();
    expect(n.notificationPrefs.value).toEqual({ needsInput: true, finished: false, failed: true, backgroundOnly: false });
  });
  it("turning a kind on asks for permission the first time", async () => {
    const fake = fakeBackend("default");
    n.startNotifications(fake.backend);
    await flush();
    expect(n.notificationPermission.value).toBe("default");
    n.updateNotificationPrefs({ failed: true });
    await flush();
    expect(fake.backend.request).toHaveBeenCalledOnce();
    expect(n.notificationPermission.value).toBe("granted");
  });
  it("doesn't show banners while denied", async () => {
    const fake = fakeBackend("denied");
    n.startNotifications(fake.backend);
    await flush();
    n.observeSessionUpsert(running, base({ unread: true, lastActivityAt: 7 }), undefined);
    await flush();
    expect(fake.shown).toEqual([]);
    expect(fake.backend.request).not.toHaveBeenCalled();
  });
});
