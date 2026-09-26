import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Chat, Project } from "@pi-ui/protocol";
import { JsonFile } from "../src/store/json-file.js";
import { Store } from "../src/store/store.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-ui-store-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const project: Project = { id: "p1", name: "Proj", path: "/tmp", sortOrder: 0, createdAt: 1, lastActivityAt: 1 };
const chat: Chat = {
  id: "c1",
  projectId: "p1",
  title: "Hello",
  titleSource: "auto",
  cwd: "/tmp",
  harness: "fake",
  sessionRef: "s1",
  pinned: false,
  unread: true,
  createdAt: 1,
  lastActivityAt: 2,
  model: { provider: "fake", id: "smart" },
  thinkingLevel: "low",
};

describe("JsonFile", () => {
  it("falls back when missing, writes atomically and reads back", () => {
    const path = join(tempDir(), "nested", "x.json");
    const f = new JsonFile(path, () => ({ n: 0 }), 0);
    expect(f.get()).toEqual({ n: 0 });
    f.set({ n: 2 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ n: 2 });
    expect(new JsonFile(path, () => ({ n: -1 })).get()).toEqual({ n: 2 });
  });

  it("debounces writes until flush", () => {
    const path = join(tempDir(), "x.json");
    const f = new JsonFile(path, () => ({ n: 0 }), 10_000);
    f.set({ n: 1 });
    expect(() => readFileSync(path)).toThrow();
    f.flush();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ n: 1 });
  });

  it("uses the fallback for corrupt files", () => {
    const path = join(tempDir(), "x.json");
    writeFileSync(path, "{nope");
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(new JsonFile(path, () => ({ ok: true })).get()).toEqual({ ok: true });
    } finally {
      console.warn = warn;
    }
  });
});

describe("Store", () => {
  it("round-trips projects, chats and settings", () => {
    const dir = tempDir();
    const store = new Store(dir);
    store.upsertProject(project);
    store.upsertChat(chat);
    store.upsertChat({ ...chat, id: "c2", title: "Other" });
    store.upsertChat({ ...chat, title: "Renamed" });
    store.removeChat("c2");
    store.updateSettings({ general: { sendKey: "mod-enter" }, models: { hiddenModels: ["a/b"] } });
    store.flush();

    const reloaded = new Store(dir);
    expect(reloaded.listProjects()).toEqual([project]);
    expect(reloaded.listChats()).toEqual([{ ...chat, title: "Renamed" }]);
    const settings = reloaded.getSettings();
    expect(settings.general.sendKey).toBe("mod-enter");
    expect(settings.general.generateTitles).toBe(true); // default preserved
    expect(settings.models.hiddenModels).toEqual(["a/b"]);
    // Only overrides are stored.
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({
      general: { sendKey: "mod-enter" },
      models: { hiddenModels: ["a/b"] },
    });

    reloaded.removeProject("p1");
    reloaded.flush();
    expect(new Store(dir).listProjects()).toEqual([]);
  });
});

describe("settings migration", () => {
  it("drops the removed notifyOnComplete setting", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ui-settings-"));
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ general: { notifyOnComplete: false, sendKey: "mod-enter" } }));
    const store = new Store(dir, 0);
    expect(store.getSettings().general).not.toHaveProperty("notifyOnComplete");
    expect(store.getSettings().general.sendKey).toBe("mod-enter");
    store.flush();
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).general).toEqual({ sendKey: "mod-enter" });
    rmSync(dir, { recursive: true, force: true });
  });
});
