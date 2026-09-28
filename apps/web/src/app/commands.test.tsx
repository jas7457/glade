/** Command registry: chat actions for the current chat (I-073 Mark as Unread / Read). */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: { updateSession: vi.fn(async (id: string, patch: object) => ({ ...sessions.value.find((s) => s.id === id), ...patch })) },
}));

import { api } from "@/lib/api";
import { projects, sessions, workspaces } from "@/state/store";
import { makeProject, makeSession, makeWorkspace } from "@/test/fixtures";
import { buildCommands, isAvailable } from "./commands";

const build = (workspaceId: string | null) =>
  buildCommands({ navigate: vi.fn(), route: { workspaceId, projectId: null, isSettings: false, envId: null }, togglePalette: vi.fn() });
const markCommand = (workspaceId: string | null) => build(workspaceId).find((c) => c.id === "mark-unread")!;

describe("Mark as Unread command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/");
    projects.value = [makeProject({ id: "p" })];
    workspaces.value = [
      makeWorkspace({ id: "w", layout: { activeMainSessionId: "m1" } }),
      makeWorkspace({ id: "u", unread: true, status: "unread" }),
    ];
    sessions.value = [
      makeSession({ id: "m1", workspaceId: "w", createdAt: 1 }),
      makeSession({ id: "m2", workspaceId: "w", createdAt: 2 }),
      makeSession({ id: "u1", workspaceId: "u", unread: true, status: "unread" }),
    ];
  });

  it("is only available with a current chat", () => {
    expect(isAvailable(markCommand(null))).toBe(false);
    expect(isAvailable(markCommand("w"))).toBe(true);
  });

  it("marks the tab on screen unread", async () => {
    window.history.replaceState(null, "", "/chats/w?tab=m2");
    const cmd = markCommand("w");
    expect(cmd.title).toBe("Mark as Unread");
    await cmd.run();
    expect(api.updateSession).toHaveBeenCalledWith("m2", { unread: true });
  });

  it("falls back to the focused main tab without ?tab=", async () => {
    await markCommand("w").run();
    expect(api.updateSession).toHaveBeenCalledWith("m1", { unread: true });
  });

  it("becomes Mark as Read for an unread chat", async () => {
    const cmd = markCommand("u");
    expect(cmd.title).toBe("Mark as Read");
    await cmd.run();
    expect(api.updateSession).toHaveBeenCalledWith("u1", { unread: false });
  });
});
