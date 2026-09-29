import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@glade/protocol";

vi.mock("@/lib/api", () => ({
  api: { updateSettings: vi.fn(), updateWorkspace: vi.fn(), deleteProject: vi.fn(), reorderProjects: vi.fn(), reorderPinnedWorkspaces: vi.fn(), updateSession: vi.fn() },
}));

import { api } from "@/lib/api";
import { sessions, workspaces, workspacesForProject, projects, settings, sortedProjects } from "./store";
import { markWorkspaceUnread, mergeSettings, movePinnedWorkspace, moveProject, removeProject, reorderPinnedWorkspaces, reorderProjects, stepOrder, updateSettings } from "./actions";
import { toasts } from "./toasts";
import { makeProject, makeSession, makeWorkspace } from "@/test/fixtures";

const mocked = vi.mocked(api);

describe("mergeSettings", () => {
  it("deep merges objects and replaces arrays/scalars", () => {
    const base = { ...defaultSettings(), models: { ...defaultSettings().models, hiddenModels: ["a/b"] } };
    const out = mergeSettings(base, { general: { generateTitles: false }, models: { hiddenModels: ["c/d"] } });
    expect(out.general).toEqual({ ...base.general, generateTitles: false });
    expect(out.models.hiddenModels).toEqual(["c/d"]);
    expect(out.appearance).toBe(base.appearance);
  });
  it("replaces a null model ref", () => {
    const out = mergeSettings(defaultSettings(), { models: { defaultModel: { provider: "p", id: "m" } } });
    expect(out.models.defaultModel).toEqual({ provider: "p", id: "m" });
  });
});

describe("updateSettings", () => {
  beforeEach(() => {
    settings.value = defaultSettings();
    toasts.value = [];
    vi.clearAllMocks();
  });

  it("applies the patch optimistically, then the server result", async () => {
    let resolve!: (v: ReturnType<typeof defaultSettings>) => void;
    mocked.updateSettings.mockReturnValue(new Promise((r) => (resolve = r)));
    const done = updateSettings({ appearance: { theme: "dark" } });
    expect(settings.value.appearance.theme).toBe("dark");
    expect(mocked.updateSettings).toHaveBeenCalledWith({ appearance: { theme: "dark" } });
    const server = mergeSettings(defaultSettings(), { appearance: { theme: "dark" }, general: { generateTitles: false } });
    resolve(server);
    expect(await done).toBe(true);
    expect(settings.value).toEqual(server);
  });

  it("reverts and shows a toast on failure", async () => {
    mocked.updateSettings.mockRejectedValue(new Error("nope"));
    expect(await updateSettings({ general: { generateTitles: false } })).toBe(false);
    expect(settings.value.general.generateTitles).toBe(true);
    expect(toasts.value[0]?.message).toContain("nope");
  });
});

describe("removeProject", () => {
  it("drops the project and its workspaces locally", async () => {
    projects.value = [makeProject({ id: "p" }), makeProject({ id: "q" })];
    workspaces.value = [makeWorkspace({ id: "a", projectId: "p" }), makeWorkspace({ id: "b", projectId: "q" })];
    mocked.deleteProject.mockResolvedValue(undefined);
    expect(await removeProject("p")).toBe(true);
    expect(projects.value.map((p) => p.id)).toEqual(["q"]);
    expect(workspaces.value.map((c) => c.id)).toEqual(["b"]);
  });
});

describe("stepOrder", () => {
  it("swaps with the neighbour, null at the edges", () => {
    expect(stepOrder(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(stepOrder(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(stepOrder(["a", "b"], "a", -1)).toBeNull();
    expect(stepOrder(["a", "b"], "b", 1)).toBeNull();
    expect(stepOrder(["a"], "x", 1)).toBeNull();
  });
});

describe("reorderProjects", () => {
  beforeEach(() => {
    toasts.value = [];
    vi.clearAllMocks();
    projects.value = [makeProject({ id: "a", sortOrder: 0 }), makeProject({ id: "b", sortOrder: 1 }), makeProject({ id: "c", sortOrder: 2 })];
  });

  it("reorders optimistically, then sends the full order", async () => {
    let resolve!: (v: never[]) => void;
    mocked.reorderProjects.mockReturnValue(new Promise((r) => (resolve = r)));
    const done = reorderProjects(["c", "a", "b"]);
    expect(sortedProjects.value.map((p) => p.id)).toEqual(["c", "a", "b"]);
    expect(mocked.reorderProjects).toHaveBeenCalledWith(["c", "a", "b"]);
    resolve([]);
    expect(await done).toBe(true);
    expect(sortedProjects.value.map((p) => p.id)).toEqual(["c", "a", "b"]);
  });

  it("rolls back and shows a toast on failure", async () => {
    mocked.reorderProjects.mockRejectedValue(new Error("offline"));
    expect(await reorderProjects(["b", "a", "c"])).toBe(false);
    expect(sortedProjects.value.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(toasts.value[0]?.message).toContain("offline");
  });

  it("moveProject steps one place and ignores the edges", async () => {
    mocked.reorderProjects.mockResolvedValue([]);
    expect(await moveProject("a", -1)).toBe(false);
    expect(mocked.reorderProjects).not.toHaveBeenCalled();
    await moveProject("a", 1);
    expect(mocked.reorderProjects).toHaveBeenCalledWith(["b", "a", "c"]);
  });
});

describe("reorderPinnedWorkspaces", () => {
  beforeEach(() => {
    toasts.value = [];
    vi.clearAllMocks();
    workspaces.value = [
      makeWorkspace({ id: "x", projectId: "p", pinned: true, pinOrder: 0 }),
      makeWorkspace({ id: "y", projectId: "p", pinned: true, pinOrder: 1 }),
      makeWorkspace({ id: "z", projectId: "p", createdAt: 5 }),
    ];
  });

  it("reorders optimistically and applies the server result", async () => {
    const y = { ...workspaces.value[1]!, pinOrder: 0 };
    mocked.reorderPinnedWorkspaces.mockResolvedValue([y]);
    const done = reorderPinnedWorkspaces("p", ["y", "x"]);
    expect(workspacesForProject("p").map((c) => c.id)).toEqual(["y", "x", "z"]);
    expect(mocked.reorderPinnedWorkspaces).toHaveBeenCalledWith("p", ["y", "x"]);
    expect(await done).toBe(true);
    expect(workspacesForProject("p").map((c) => c.id)).toEqual(["y", "x", "z"]);
  });

  it("rolls back on failure", async () => {
    mocked.reorderPinnedWorkspaces.mockRejectedValue(new Error("boom"));
    expect(await reorderPinnedWorkspaces("p", ["y", "x"])).toBe(false);
    expect(workspacesForProject("p").map((c) => c.id)).toEqual(["x", "y", "z"]);
    expect(toasts.value[0]?.message).toContain("boom");
  });

  it("movePinnedWorkspace only moves pinned workspaces within their pinned group", async () => {
    mocked.reorderPinnedWorkspaces.mockResolvedValue([]);
    expect(await movePinnedWorkspace("z", -1)).toBe(false);
    expect(await movePinnedWorkspace("y", 1)).toBe(false);
    await movePinnedWorkspace("y", -1);
    expect(mocked.reorderPinnedWorkspaces).toHaveBeenCalledWith("p", ["y", "x"]);
  });
});

describe("markWorkspaceUnread (I-073)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessions.value = [
      makeSession({ id: "m1", workspaceId: "w", createdAt: 1 }),
      makeSession({ id: "m2", workspaceId: "w", createdAt: 2 }),
      makeSession({ id: "a1", workspaceId: "w", kind: "subagent", parentSessionId: "m2", createdAt: 3 }),
    ];
    mocked.updateSession.mockImplementation(async (id, patch) => ({ ...sessions.value.find((s) => s.id === id)!, ...patch }));
  });

  it("flags the focused main tab (the last one open)", async () => {
    workspaces.value = [makeWorkspace({ id: "w", layout: { activeMainSessionId: "m2" } })];
    expect(await markWorkspaceUnread("w")).toBe(true);
    expect(mocked.updateSession).toHaveBeenCalledTimes(1);
    expect(mocked.updateSession).toHaveBeenCalledWith("m2", { unread: true });
    expect(sessions.value.find((s) => s.id === "m2")?.unread).toBe(true);
  });

  it("falls back to the first main tab without a (valid) focused tab", async () => {
    workspaces.value = [makeWorkspace({ id: "w", layout: { activeMainSessionId: "gone" } })];
    await markWorkspaceUnread("w");
    expect(mocked.updateSession).toHaveBeenCalledWith("m1", { unread: true });
  });

  it("does nothing for an unknown workspace", async () => {
    workspaces.value = [];
    expect(await markWorkspaceUnread("w")).toBe(false);
    expect(mocked.updateSession).not.toHaveBeenCalled();
  });
});
