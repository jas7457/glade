import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@pi-ui/protocol";

vi.mock("@/lib/api", () => ({
  api: { updateSettings: vi.fn(), updateChat: vi.fn(), deleteProject: vi.fn() },
}));

import { api } from "@/lib/api";
import { chats, projects, settings } from "./store";
import { mergeSettings, removeProject, updateSettings } from "./actions";
import { toasts } from "./toasts";
import { makeChat, makeProject } from "@/test/fixtures";

const mocked = vi.mocked(api);

describe("mergeSettings", () => {
  it("deep merges objects and replaces arrays/scalars", () => {
    const base = { ...defaultSettings(), models: { ...defaultSettings().models, hiddenModels: ["a/b"] } };
    const out = mergeSettings(base, { general: { sendKey: "mod-enter" }, models: { hiddenModels: ["c/d"] } });
    expect(out.general).toEqual({ ...base.general, sendKey: "mod-enter" });
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
    const server = mergeSettings(defaultSettings(), { appearance: { theme: "dark", fontSize: "large" } });
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
  it("drops the project and its chats locally", async () => {
    projects.value = [makeProject({ id: "p" }), makeProject({ id: "q" })];
    chats.value = [makeChat({ id: "a", projectId: "p" }), makeChat({ id: "b", projectId: "q" })];
    mocked.deleteProject.mockResolvedValue(undefined);
    expect(await removeProject("p")).toBe(true);
    expect(projects.value.map((p) => p.id)).toEqual(["q"]);
    expect(chats.value.map((c) => c.id)).toEqual(["b"]);
  });
});
