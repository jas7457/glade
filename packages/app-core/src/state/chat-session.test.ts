/**
 * I-102: after a server restart the composer lost its thinking picker and context meter. A chat
 * loaded while another server still held it gets an offline snapshot (no context usage); it's
 * loaded again when its session changes, and chats reload (or retry) when the socket reconnects.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSessionState, emptyTranscript, type SessionDetail, type SessionState } from "@glade/protocol";
import { makeSession } from "@glade/app-core/test/fixtures";

vi.mock("@glade/app-core/lib/api", () => ({ api: { getSession: vi.fn(), listCommands: vi.fn() } }));
vi.mock("@glade/app-core/lib/socket", () => ({ socket: { watch: vi.fn(() => () => {}) } }));

const { api } = await import("@glade/app-core/lib/api");
const {
  applySessionDetail,
  applySessionSnapshot,
  applyTranscriptPatch,
  getChatSession,
  handleSessionEvent,
  loadChatCommands,
  loadChatSession,
  reloadIfChangedElsewhere,
  reloadOpenChatSessions,
  resetChatSessions,
} = await import("./chat-session");
const getSession = vi.mocked(api.getSession);

const LIVE: SessionState = {
  ...defaultSessionState(),
  model: { provider: "a", id: "m" },
  thinkingLevel: "medium",
  thinkingLevels: ["off", "low", "medium", "high"],
  contextUsage: { tokens: 1000, contextWindow: 200_000, percent: 0.5 },
};
const OFFLINE: SessionState = { ...defaultSessionState(), model: { provider: "a", id: "m" } };

function detail(state: SessionState, offline?: boolean): SessionDetail {
  return { session: makeSession({ id: "s1" }), transcript: emptyTranscript(), state, pendingUiRequests: [], ...(offline ? { offline } : {}) };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetChatSessions();
});

describe("chat session reloads (I-102)", () => {
  it("an offline snapshot is loaded again when its session changes, until it's live", async () => {
    const store = applySessionDetail(detail(OFFLINE, true));
    expect(store.offline).toBe(true);
    getSession.mockResolvedValueOnce(detail(LIVE));
    const summary = makeSession({ id: "s1" });
    reloadIfChangedElsewhere(summary, { ...summary, lastActivityAt: 1 });
    await vi.waitFor(() => expect(store.state.value.contextUsage).toEqual(LIVE.contextUsage));
    expect(store.offline).toBe(false);
    expect(store.state.value.thinkingLevels).toEqual(LIVE.thinkingLevels);

    // Live now: an unrelated change doesn't reload it.
    reloadIfChangedElsewhere(summary, { ...summary, lastActivityAt: 2 });
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("doesn't reload an offline snapshot while the session is busy in another server", () => {
    applySessionDetail(detail(OFFLINE, true));
    const busy = { ...makeSession({ id: "s1" }), activeElsewhere: { serverKind: "desktop", since: 1 } };
    reloadIfChangedElsewhere(busy, busy);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("on reconnect, reloads loaded chats and retries ones that failed while the server was down", async () => {
    getSession.mockRejectedValueOnce(new Error("Failed to fetch"));
    await loadChatSession("s2");
    expect(getChatSession("s2").status.value).toBe("error");
    applySessionDetail(detail(OFFLINE));
    getChatSession("idle"); // never opened: left alone

    getSession.mockImplementation(async (id: string) => ({ ...detail(LIVE), session: makeSession({ id }) }));
    await reloadOpenChatSessions();
    expect(getSession.mock.calls.map(([id]) => id).slice(1).sort()).toEqual(["s1", "s2"]);
    expect(getChatSession("s1").state.value.contextUsage).toEqual(LIVE.contextUsage);
    expect(getChatSession("s2").status.value).toBe("ready");
    expect(getChatSession("idle").status.value).toBe("idle");
  });
});

describe("transcript patches (I-122)", () => {
  const msg = (id: string, text: string) => ({ id, role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 0 });

  it("replaces known messages, appends new ones at their index, and skips ones before the loaded page", () => {
    applySessionSnapshot("s1", { messages: [msg("c", "c"), msg("d", "d")], toolResults: {}, start: 2, total: 4 }, { state: LIVE, pendingUiRequests: [] });
    const store = getChatSession("s1");
    expect(store.start.value).toBe(2);
    expect(applyTranscriptPatch("s1", [{ index: 0, message: msg("a", "a") }, { index: 3, message: msg("d", "d2") }, { index: 4, message: msg("e", "e") }], [])).toBe(true);
    expect(store.transcript.value.messages.map((m) => (m.role === "user" && m.content[0]?.type === "text" ? m.content[0].text : ""))).toEqual(["c", "d2", "e"]);
    // A message far past the end doesn't fit: the caller starts over with a snapshot.
    expect(applyTranscriptPatch("s1", [{ index: 9, message: msg("z", "z") }], [])).toBe(false);
  });
});

describe("slash commands (I-185)", () => {
  it("loads them once, and again when the harness says they changed (keeping the old list meanwhile)", async () => {
    const listCommands = vi.mocked(api.listCommands);
    listCommands.mockResolvedValueOnce([{ name: "review", source: "harness" }] as never);
    const store = applySessionDetail(detail(LIVE));
    await loadChatCommands("s1");
    await loadChatCommands("s1");
    expect(listCommands).toHaveBeenCalledTimes(1);

    let resolve: (v: never) => void = () => {};
    listCommands.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    handleSessionEvent("s1", { type: "commands_changed" });
    await vi.waitFor(() => expect(listCommands).toHaveBeenCalledTimes(2));
    expect(store.commands.value!.map((c) => c.name)).toEqual(["review"]);
    resolve([{ name: "review" }, { name: "pdf" }] as never);
    await vi.waitFor(() => expect(store.commands.value!.map((c) => c.name)).toEqual(["review", "pdf"]));

    // Never loaded (the menu wasn't opened): nothing to refresh.
    applySessionDetail({ ...detail(LIVE), session: makeSession({ id: "s3" }) });
    handleSessionEvent("s3", { type: "commands_changed" });
    await Promise.resolve();
    expect(listCommands).toHaveBeenCalledTimes(2);
  });
});
