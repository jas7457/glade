import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Project, Session, Workspace } from "@glade/protocol";
import type { LegacyChat } from "../src/store/migrate-workspaces.js";
import { JsonFile } from "../src/store/json-file.js";
import { Store } from "../src/store/store.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "glade-store-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const project: Project = { id: "p1", name: "Proj", path: "/tmp", sortOrder: 0, createdAt: 1, lastActivityAt: 1 };
const workspace: Workspace = {
  id: "w1",
  projectId: "p1",
  title: "Hello",
  titleSource: "auto",
  cwd: "/tmp",
  pinned: false,
  createdAt: 1,
  lastActivityAt: 2,
  layout: null,
};
const session: Session = {
  id: "s1",
  workspaceId: "w1",
  kind: "main",
  parentSessionId: null,
  agentName: null,
  title: "Hello",
  titleSource: "auto",
  harness: "fake",
  sessionRef: "ref1",
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
  it("round-trips projects, workspaces, sessions and settings", () => {
    const dir = tempDir();
    const store = new Store(dir);
    store.upsertProject(project);
    store.upsertWorkspace(workspace);
    store.upsertWorkspace({ ...workspace, id: "w2", title: "Other" });
    store.upsertWorkspace({ ...workspace, title: "Renamed" });
    store.upsertSession(session);
    store.upsertSession({ ...session, id: "s2", workspaceId: "w2" });
    store.upsertSession({ ...session, id: "s3", kind: "subagent", parentSessionId: "s1", agentName: "reviewer" });
    store.upsertSession({ ...session, title: "Tab" });
    store.removeWorkspace("w2"); // takes its sessions along
    store.updateSettings({ general: { sendKey: "mod-enter" }, models: { hiddenModels: ["a/b"] } });
    store.flush();

    const reloaded = new Store(dir);
    expect(reloaded.listProjects()).toEqual([project]);
    expect(reloaded.listWorkspaces()).toEqual([{ ...workspace, title: "Renamed" }]);
    expect(reloaded.listSessions().map((x) => x.id)).toEqual(["s1", "s3"]);
    expect(reloaded.getSession("s1")).toEqual({ ...session, title: "Tab" });
    expect(reloaded.listSessions("w1")).toHaveLength(2);
    expect(reloaded.listSessions("w2")).toEqual([]);
    reloaded.removeSession("s3");
    expect(reloaded.listSessions().map((x) => x.id)).toEqual(["s1"]);
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
    const dir = mkdtempSync(join(tmpdir(), "glade-settings-"));
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ general: { notifyOnComplete: false, sendKey: "mod-enter" } }));
    const store = new Store(dir, 0);
    expect(store.getSettings().general).not.toHaveProperty("notifyOnComplete");
    expect(store.getSettings().general.sendKey).toBe("mod-enter");
    store.flush();
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).general).toEqual({ sendKey: "mod-enter" });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("workspaces migration (I-035)", () => {
  const legacy: LegacyChat & { archived: boolean } = {
    id: "c1",
    projectId: "p1",
    title: "Fix login",
    titleSource: "user",
    cwd: "/proj",
    harness: "pi",
    sessionRef: "/sessions/a.jsonl",
    pinned: true,
    pinOrder: 3,
    unread: true,
    lastRunFailed: true,
    runInProgress: false,
    interrupted: true,
    archived: false,
    createdAt: 10,
    lastActivityAt: 20,
    model: { provider: "anthropic", id: "claude-haiku-4-5" },
    thinkingLevel: "low",
  };
  const other: LegacyChat = { ...legacy, id: "c2", projectId: null, pinned: false, pinOrder: undefined, sessionRef: null, titleSource: "auto" };

  function writeLegacy(dir: string, chats: unknown[]) {
    writeFileSync(join(dir, "chats.json"), JSON.stringify({ version: 1, chats }));
  }

  it("turns each chat into a workspace with one main session, keeping ids", () => {
    const dir = tempDir();
    writeLegacy(dir, [legacy, other]);
    const store = new Store(dir, 0);

    expect(store.listWorkspaces()).toEqual([
      { id: "c1", projectId: "p1", title: "Fix login", titleSource: "user", cwd: "/proj", pinned: true, pinOrder: 3, createdAt: 10, lastActivityAt: 20, layout: null },
      { id: "c2", projectId: null, title: "Fix login", titleSource: "auto", cwd: "/proj", pinned: false, createdAt: 10, lastActivityAt: 20, layout: null },
    ]);
    expect(store.getSession("c1")).toEqual({
      id: "c1",
      workspaceId: "c1",
      kind: "main",
      parentSessionId: null,
      agentName: null,
      title: "Fix login",
      titleSource: "user",
      harness: "pi",
      sessionRef: "/sessions/a.jsonl",
      unread: true,
      lastRunFailed: true,
      runInProgress: false,
      interrupted: true,
      createdAt: 10,
      lastActivityAt: 20,
      model: { provider: "anthropic", id: "claude-haiku-4-5" },
      thinkingLevel: "low",
    });
    expect(store.getSession("c2")).toMatchObject({ workspaceId: "c2", sessionRef: null });
    // Written right away; chats.json is left as it was.
    expect(JSON.parse(readFileSync(join(dir, "workspaces.json"), "utf8")).sessions).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(dir, "chats.json"), "utf8")).chats).toHaveLength(2);
  });

  it("runs once: later changes survive restarts even though chats.json is still there", () => {
    const dir = tempDir();
    writeLegacy(dir, [legacy, other]);
    const first = new Store(dir, 0);
    first.removeWorkspace("c2");
    first.upsertWorkspace({ ...first.getWorkspace("c1")!, title: "Renamed" });
    first.flush();

    const second = new Store(dir, 0);
    expect(second.listWorkspaces().map((w) => [w.id, w.title])).toEqual([["c1", "Renamed"]]);
    expect(second.listSessions().map((x) => x.id)).toEqual(["c1"]);
  });

  it("assigns pinOrder to pinned chats that lack one and drops stray ones", () => {
    const dir = tempDir();
    writeLegacy(dir, [
      { ...legacy, id: "a", pinOrder: undefined, lastActivityAt: 1 },
      { ...legacy, id: "b", pinOrder: undefined, lastActivityAt: 5 },
      { ...legacy, id: "c", pinned: false, pinOrder: 7 },
    ]);
    const store = new Store(dir, 0);
    expect(store.getWorkspace("b")?.pinOrder).toBe(0);
    expect(store.getWorkspace("a")?.pinOrder).toBe(1);
    expect(store.getWorkspace("c")).not.toHaveProperty("pinOrder");
  });

  it("starts empty without chats.json, and doesn't overwrite an unreadable one", () => {
    const empty = tempDir();
    expect(new Store(empty, 0).listWorkspaces()).toEqual([]);

    const corrupt = tempDir();
    writeFileSync(join(corrupt, "chats.json"), "{nope");
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(new Store(corrupt, 0).listWorkspaces()).toEqual([]);
    } finally {
      console.warn = warn;
    }
    expect(existsSync(join(corrupt, "workspaces.json"))).toBe(false);
  });
});
