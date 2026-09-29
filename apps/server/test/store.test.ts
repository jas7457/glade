import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Project, Session, Workspace } from "@glade/protocol";
import type { LegacyChat } from "../src/store/migrate-workspaces.js";
import { DB_FILE, openDatabase } from "../src/store/db/database.js";
import { migrateSettings, Store } from "../src/store/store.js";

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
    store.updateSettings({ general: { generateTitles: false }, models: { hiddenModels: ["a/b"] } });
    store.flush();

    const reloaded = new Store(dir);
    expect(reloaded.listProjects()).toEqual([{ ...project, environmentId: store.environmentId }]); // I-123
    expect(reloaded.listWorkspaces()).toEqual([{ ...workspace, title: "Renamed" }]);
    expect(reloaded.listSessions().map((x) => x.id)).toEqual(["s1", "s3"]);
    expect(reloaded.getSession("s1")).toEqual({ ...session, title: "Tab" });
    expect(reloaded.listSessions("w1")).toHaveLength(2);
    expect(reloaded.listSessions("w2")).toEqual([]);
    reloaded.removeSession("s3");
    expect(reloaded.listSessions().map((x) => x.id)).toEqual(["s1"]);
    const settings = reloaded.getSettings();
    expect(settings.general.generateTitles).toBe(false);
    expect(settings.general.generateSummaries).toBe(true); // default preserved
    expect(settings.models.hiddenModels).toEqual(["a/b"]);
    // Only overrides are stored (and exported as JSON for the desktop app).
    const overrides = { general: { generateTitles: false }, models: { hiddenModels: ["a/b"] } };
    expect(reloaded.getSettingsOverrides()).toEqual(overrides);
    expect(JSON.parse(readFileSync(join(dir, "settings.export.json"), "utf8"))).toEqual(overrides);
    expect(existsSync(join(dir, "settings.json"))).toBe(false);

    reloaded.removeProject("p1");
    reloaded.flush();
    expect(new Store(dir).listProjects()).toEqual([]);
  });
});

describe("settings migration", () => {
  it("drops the removed notifyOnComplete, sendKey and busyBehavior settings (I-028, I-153)", () => {
    const dir = mkdtempSync(join(tmpdir(), "glade-settings-"));
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ general: { notifyOnComplete: false, sendKey: "mod-enter", busyBehavior: "followUp", generateTitles: false } }),
    );
    const store = new Store(dir, 0);
    expect(store.getSettings().general).toEqual({ generateTitles: false, generateSummaries: true });
    expect(store.getSettingsOverrides().general).toEqual({ generateTitles: false });
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads old sendKey/busyBehavior values in the database fine and drops them on the next write (I-153)", () => {
    const dir = tempDir();
    new Store(dir, 0).flush();
    // Stored by an older Glade.
    const db = openDatabase(join(dir, DB_FILE));
    db.prepare("INSERT INTO settings (id, data_json, updated_at) VALUES (1, ?, 1) ON CONFLICT (id) DO UPDATE SET data_json = excluded.data_json").run(
      JSON.stringify({ general: { sendKey: "mod-enter", busyBehavior: "followUp", generateTitles: false } }),
    );
    db.close();
    const store = new Store(dir, 0);
    expect(store.getSettings().general).toEqual({ generateTitles: false, generateSummaries: true });
    store.updateSettings({ models: { hiddenModels: ["a/b"] } });
    expect(store.getSettingsOverrides()).toEqual({ general: { generateTitles: false }, models: { hiddenModels: ["a/b"] } });
    // An older client's patch doesn't bring them back either.
    store.updateSettings({ general: { sendKey: "enter" } } as never);
    expect(store.getSettingsOverrides().general).toEqual({ generateTitles: false });
  });

  it("moves pi's settings from agent to harnesses.pi (I-066)", () => {
    const dir = mkdtempSync(join(tmpdir(), "glade-settings-"));
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ agent: { piPath: "/opt/pi", extraArgs: ["--x"], maxIdleProcesses: 2, autoRetry: false }, general: { generateTitles: false } }),
    );
    const store = new Store(dir, 0);
    const settings = store.getSettings();
    expect(settings.agent).toEqual({ maxIdleProcesses: 2, defaultHarness: null, subagents: true });
    expect(settings.harnesses.pi).toEqual({ piPath: "/opt/pi", extraArgs: ["--x"], autoCompaction: true, autoRetry: false });
    expect(store.getSettingsOverrides()).toEqual({
      agent: { maxIdleProcesses: 2 },
      harnesses: { pi: { piPath: "/opt/pi", extraArgs: ["--x"], autoRetry: false } },
      general: { generateTitles: false },
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps values already under harnesses.pi and leaves migrated files alone", () => {
    const migrated = migrateSettings({ agent: { piPath: "old" } as never, harnesses: { pi: { piPath: "new" } } });
    expect(migrated).toEqual({ agent: {}, harnesses: { pi: { piPath: "new" } } });
    const current = { agent: { maxIdleProcesses: 1 }, harnesses: { pi: { autoRetry: false } } };
    expect(migrateSettings(current)).toBe(current);
  });

  it("renames models.titleModel to smallModel, keeping the choice (I-074)", () => {
    const dir = mkdtempSync(join(tmpdir(), "glade-settings-"));
    const haiku = { provider: "anthropic", id: "claude-haiku-4-5" };
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ models: { titleModel: haiku, hiddenModels: ["a/b"] } }));
    const store = new Store(dir, 0);
    expect(store.getSettings().models).toMatchObject({ smallModel: haiku, hiddenModels: ["a/b"], subagentModel: null, subagentThinkingLevel: null });
    expect(store.getSettings().models).not.toHaveProperty("titleModel");
    expect(store.getSettingsOverrides()).toEqual({ models: { smallModel: haiku, hiddenModels: ["a/b"] } });
    rmSync(dir, { recursive: true, force: true });
    // A value already under smallModel wins; migrated files are left alone.
    const both = { models: { titleModel: null, smallModel: haiku } } as never;
    expect(migrateSettings(both)).toEqual({ models: { smallModel: haiku } });
    const current = { models: { smallModel: null } };
    expect(migrateSettings(current)).toBe(current);
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
    // Imported into glade.db; chats.json is left as it was (no workspaces.json is written).
    expect(existsSync(join(dir, "workspaces.json"))).toBe(false);
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

  it("starts empty without chats.json, and reports (and keeps) an unreadable one", () => {
    const empty = tempDir();
    expect(new Store(empty, 0).listWorkspaces()).toEqual([]);

    const corrupt = tempDir();
    writeFileSync(join(corrupt, "chats.json"), "{nope");
    const store = new Store(corrupt, 0);
    expect(store.listWorkspaces()).toEqual([]);
    expect(store.jsonImport?.failed.map((f) => f.file)).toEqual(["chats.json"]);
    expect(readFileSync(join(corrupt, "chats.json"), "utf8")).toBe("{nope");
  });
});
