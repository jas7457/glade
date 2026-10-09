/**
 * I-035 data layer: workspaces + sessions signals, server pushes, tab resolution and the
 * workspace/session actions.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@glade/app-core/lib/api", () => ({
  api: {
    createWorkspace: vi.fn(),
    createSession: vi.fn(),
    deleteSession: vi.fn(),
    deleteWorkspace: vi.fn(),
    updateSession: vi.fn(),
    getSession: vi.fn(),
  },
}));
vi.mock("@glade/app-core/lib/socket", () => ({ socket: { send: vi.fn(), watch: vi.fn(() => () => {}) } }));

import { defaultSessionState, emptyTranscript, type SessionDetail } from "@glade/protocol";
import { api } from "@glade/app-core/lib/api";
import { makeSession, makeWorkspace } from "@glade/app-core/test/fixtures";
import { createSession, createWorkspace, deleteSession, deleteWorkspace, dismissInterrupted } from "./actions";
import { getChatSession, resetChatSessions } from "./chat-session";
import { setNewChatInFolder } from "./new-chat-in-folder";
import { folders, handleServerMessage, mainSessionsFor, resolveSessionId, sessions, sessionsById, workspaces, workspacesById } from "./store";

const mocked = vi.mocked(api);

function detail(sessionId: string, workspaceId: string): SessionDetail {
  return {
    session: makeSession({ id: sessionId, workspaceId }),
    transcript: emptyTranscript(),
    state: defaultSessionState(),
    pendingUiRequests: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetChatSessions();
  workspaces.value = [makeWorkspace({ id: "w" }), makeWorkspace({ id: "v" })];
  sessions.value = [
    makeSession({ id: "s2", workspaceId: "w", createdAt: 2 }),
    makeSession({ id: "s1", workspaceId: "w", createdAt: 1 }),
    makeSession({ id: "sub", workspaceId: "w", kind: "subagent", parentSessionId: "s1", createdAt: 3 }),
    makeSession({ id: "v", workspaceId: "v" }),
  ];
});

describe("tabs", () => {
  it("lists main sessions in tab order", () => {
    expect(mainSessionsFor("w").map((s) => s.id)).toEqual(["s1", "s2"]);
    workspaces.value = [makeWorkspace({ id: "w", layout: { mainOrder: ["s2", "s1"] } })];
    expect(mainSessionsFor("w").map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  it("resolves ?tab= to one of the workspace's main sessions, else the default tab", () => {
    expect(resolveSessionId("w")).toBe("s1");
    expect(resolveSessionId("w", "s2")).toBe("s2");
    expect(resolveSessionId("w", "sub")).toBe("s1"); // sub-agents aren't main tabs
    expect(resolveSessionId("w", "v")).toBe("s1"); // another workspace's session
    expect(resolveSessionId("w", "gone")).toBe("s1");
    expect(resolveSessionId("missing")).toBeNull();
    workspaces.value = [makeWorkspace({ id: "w", layout: { activeMainSessionId: "s2" } })];
    expect(resolveSessionId("w")).toBe("s2");
  });
});

describe("server pushes", () => {
  it("upserts and removes workspaces and sessions", () => {
    handleServerMessage({ type: "workspace_upsert", workspace: makeWorkspace({ id: "w", title: "Renamed", status: "working" }) });
    expect(workspacesById.value.get("w")).toMatchObject({ title: "Renamed", status: "working" });
    handleServerMessage({ type: "session_upsert", session: makeSession({ id: "s3", workspaceId: "w", createdAt: 9 }) });
    expect(mainSessionsFor("w").map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    handleServerMessage({ type: "session_removed", sessionId: "s2", workspaceId: "w" });
    expect(sessionsById.value.has("s2")).toBe(false);
    // Removing a workspace drops its sessions too.
    handleServerMessage({ type: "workspace_removed", workspaceId: "w" });
    expect(workspaces.value.map((w) => w.id)).toEqual(["v"]);
    expect(sessions.value.map((s) => s.id)).toEqual(["v"]);
  });

  it("reloads an open session when it starts or stops running in another server (I-062)", async () => {
    mocked.getSession.mockResolvedValue(detail("s1", "w"));
    getChatSession("s1").status.value = "ready";
    handleServerMessage({ type: "session_upsert", session: makeSession({ id: "s1", workspaceId: "w", createdAt: 1 }) });
    expect(mocked.getSession).not.toHaveBeenCalled(); // nothing changed elsewhere
    const elsewhere = { serverKind: "desktop", since: 5 };
    handleServerMessage({ type: "session_upsert", session: makeSession({ id: "s1", workspaceId: "w", createdAt: 1, activeElsewhere: elsewhere }) });
    expect(mocked.getSession).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    handleServerMessage({ type: "session_upsert", session: makeSession({ id: "s1", workspaceId: "w", createdAt: 1 }) });
    expect(mocked.getSession).toHaveBeenCalledTimes(2);
  });

  it("routes session events to that session's store only", () => {
    const a = getChatSession("s1");
    const b = getChatSession("s2");
    a.status.value = "ready";
    b.status.value = "ready";
    handleServerMessage({ type: "session_event", sessionId: "s1", workspaceId: "w", event: { type: "state", state: { isRunning: true } } });
    expect(a.state.value.isRunning).toBe(true);
    expect(b.state.value.isRunning).toBe(false);
  });
});

describe("actions", () => {
  it("createWorkspace seeds the workspace, its sessions and the session store", async () => {
    mocked.createWorkspace.mockResolvedValue({
      workspace: makeWorkspace({ id: "new" }),
      sessions: [makeSession({ id: "new-s", workspaceId: "new" })],
      session: detail("new-s", "new"),
    });
    const created = await createWorkspace({ projectId: null, prompt: "hi" });
    expect(created.workspace.id).toBe("new");
    expect(workspacesById.value.has("new")).toBe(true);
    expect(resolveSessionId("new")).toBe("new-s");
    expect(getChatSession("new-s").status.value).toBe("ready");
  });

  it("createWorkspace sends the folder the new-chat screen was opened for (I-215)", async () => {
    mocked.createWorkspace.mockResolvedValue({
      workspace: makeWorkspace({ id: "new2" }),
      sessions: [makeSession({ id: "new2-s", workspaceId: "new2" })],
      session: detail("new2-s", "new2"),
    });
    folders.value = [{ id: "F", name: "Work", projectId: null, sortOrder: 0, createdAt: 0 }];
    setNewChatInFolder("F");
    await createWorkspace({ projectId: null, prompt: "hi" });
    expect(mocked.createWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: null, folderId: "F" }));
    setNewChatInFolder(null);
    await createWorkspace({ projectId: null, prompt: "hi" });
    expect(mocked.createWorkspace.mock.calls.at(-1)![0]).not.toHaveProperty("folderId");
  });

  it("createSession adds a tab", async () => {
    mocked.createSession.mockResolvedValue(detail("s9", "w"));
    expect(await createSession("w")).not.toBeNull();
    expect(mocked.createSession).toHaveBeenCalledWith("w", {});
    expect(mainSessionsFor("w").map((s) => s.id)).toContain("s9");
  });

  it("deleteSession removes the tab and its sub-agents; deleteWorkspace everything", async () => {
    mocked.deleteSession.mockResolvedValue(undefined);
    await deleteSession("s1");
    expect(sessions.value.map((s) => s.id)).toEqual(["s2", "v"]);
    mocked.deleteWorkspace.mockResolvedValue(undefined);
    await deleteWorkspace("w");
    expect(sessions.value.map((s) => s.id)).toEqual(["v"]);
    expect(workspaces.value.map((w) => w.id)).toEqual(["v"]);
  });

  it("dismissInterrupted patches the session", async () => {
    mocked.updateSession.mockResolvedValue(makeSession({ id: "s1", workspaceId: "w" }));
    await dismissInterrupted("s1");
    expect(mocked.updateSession).toHaveBeenCalledWith("s1", { interrupted: false });
  });
});
