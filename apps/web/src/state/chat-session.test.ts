/**
 * I-102: after a server restart the composer lost its thinking picker and context meter. A chat
 * loaded while another server still held it gets an offline snapshot (no context usage); it's
 * loaded again when its session changes, and chats reload (or retry) when the socket reconnects.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSessionState, emptyTranscript, type SessionDetail, type SessionState } from "@glade/protocol";
import { makeSession } from "@/test/fixtures";

vi.mock("@/lib/api", () => ({ api: { getSession: vi.fn() } }));
vi.mock("@/lib/socket", () => ({ socket: { watch: vi.fn(() => () => {}) } }));

const { api } = await import("@/lib/api");
const { applySessionDetail, getChatSession, loadChatSession, reloadIfChangedElsewhere, reloadOpenChatSessions, resetChatSessions } = await import(
  "./chat-session"
);
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
