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
    store.updateSettings({ general: { generateTitles: false }, models: { agents: { pi: { hiddenModels: ["a/b"] } } } });
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
    expect(settings.models.agents.pi?.hiddenModels).toEqual(["a/b"]);
    // Only overrides are stored (and exported as JSON for the desktop app).
    const overrides = { general: { generateTitles: false }, models: { agents: { pi: { hiddenModels: ["a/b"] } } } };
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
    store.updateSettings({ models: { agents: { pi: { hiddenModels: ["a/b"] } } } });
    expect(store.getSettingsOverrides()).toEqual({ general: { generateTitles: false }, models: { agents: { pi: { hiddenModels: ["a/b"] } } } });
    // An older client's patch doesn't bring them back either.
    store.updateSettings({ general: { sendKey: "enter" } } as never);
    expect(store.getSettingsOverrides().general).toEqual({ generateTitles: false });
  });

  it("drops the removed Text size (appearance.fontSize) on read and on write (I-161)", () => {
    const dir = tempDir();
    new Store(dir, 0).flush();
    const db = openDatabase(join(dir, DB_FILE));
    db.prepare("INSERT INTO settings (id, data_json, updated_at) VALUES (1, ?, 1) ON CONFLICT (id) DO UPDATE SET data_json = excluded.data_json").run(
      JSON.stringify({ appearance: { theme: "dark", fontSize: "large" } }),
    );
    db.close();
    const store = new Store(dir, 0);
    expect(store.getSettings().appearance).toEqual({ theme: "dark" });
    store.updateSettings({ appearance: { theme: "light", fontSize: "small" } } as never);
    expect(store.getSettingsOverrides()).toEqual({ appearance: { theme: "light" } });
    expect(store.getSettings().appearance).toEqual({ theme: "light" });
  });

  it("drops pi's settings (old agent.* and harnesses.pi) and the idle limit from an old JSON import (I-159)", () => {
    const dir = mkdtempSync(join(tmpdir(), "glade-settings-"));
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ agent: { piPath: "/opt/pi", extraArgs: ["--x"], maxIdleProcesses: 2, autoRetry: false }, general: { generateTitles: false } }),
    );
    const store = new Store(dir, 0);
    const settings = store.getSettings();
    expect(settings.agent).toEqual({ defaultHarness: null, subagents: true });
    expect(settings.harnesses).toEqual({ acp: { agents: [] } });
    expect(store.getSettingsOverrides()).toEqual({ agent: {}, general: { generateTitles: false } });
    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores removed agent settings in the database and drops them on write; keeps custom ACP agents (I-159)", () => {
    const dir = tempDir();
    new Store(dir, 0).flush();
    const mine = { id: "mine", name: "Mine", command: "mine-acp", args: [], env: {} };
    const db = openDatabase(join(dir, DB_FILE));
    db.prepare("INSERT INTO settings (id, data_json, updated_at) VALUES (1, ?, 1) ON CONFLICT (id) DO UPDATE SET data_json = excluded.data_json").run(
      JSON.stringify({
        agent: { maxIdleProcesses: 9, subagents: false },
        harnesses: { pi: { piPath: "/opt/pi", extraArgs: ["--x"], autoCompaction: false, autoRetry: false }, acp: { agents: [mine] } },
      }),
    );
    db.close();
    const store = new Store(dir, 0);
    expect(store.getSettings().agent).toEqual({ defaultHarness: null, subagents: false });
    expect(store.getSettings().harnesses).toEqual({ acp: { agents: [mine] } });
    store.updateSettings({ models: { agents: { pi: { hiddenModels: ["a/b"] } } } });
    expect(store.getSettingsOverrides()).toEqual({
      agent: { subagents: false },
      harnesses: { acp: { agents: [mine] } },
      models: { agents: { pi: { hiddenModels: ["a/b"] } } },
    });
    // An older client's patch doesn't bring them back either.
    store.updateSettings({ agent: { maxIdleProcesses: 2 }, harnesses: { pi: { piPath: "x" } } } as never);
    expect(store.getSettingsOverrides()).toMatchObject({ agent: { subagents: false }, harnesses: { acp: { agents: [mine] } } });
    expect(store.getSettingsOverrides().harnesses).not.toHaveProperty("pi");
    expect(store.getSettingsOverrides().agent).not.toHaveProperty("maxIdleProcesses");
    const current = { agent: { subagents: true }, harnesses: { acp: { agents: [] } } };
    expect(migrateSettings(current)).toBe(current);
  });

  it("renames models.titleModel to smallModel, keeping the choice (I-074), which becomes the quick-tasks model (I-198)", () => {
    const dir = mkdtempSync(join(tmpdir(), "glade-settings-"));
    const haiku = { provider: "anthropic", id: "claude-haiku-4-5" };
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ models: { titleModel: haiku, hiddenModels: ["a/b"] } }));
    const store = new Store(dir, 0);
    expect(store.getSettings().models).toEqual({ quickTasks: { harness: "pi", model: haiku }, agents: { pi: { hiddenModels: ["a/b"] } } });
    expect(store.getSettingsOverrides()).toEqual({ models: { quickTasks: { harness: "pi", model: haiku }, agents: { pi: { hiddenModels: ["a/b"] } } } });
    rmSync(dir, { recursive: true, force: true });
    // A value already under smallModel wins; migrated files are left alone.
    const both = { models: { titleModel: null, smallModel: haiku } } as never;
    expect(migrateSettings(both)).toEqual({ models: { quickTasks: { harness: "pi", model: haiku } } });
    const current = { models: { quickTasks: null, agents: {} } };
    expect(migrateSettings(current)).toBe(current);
  });

  describe("per-agent model settings (I-198)", () => {
    const sonnet = { provider: "anthropic", id: "claude-sonnet-5-5" };
    const haiku = { provider: "anthropic", id: "claude-haiku-4-5" };
    const legacy = {
      defaultModel: sonnet,
      defaultThinkingLevel: "high",
      smallModel: haiku,
      subagentModel: haiku,
      sideQuestionModel: haiku,
      subagentThinkingLevel: "low",
      hiddenModels: ["anthropic/claude-opus-4-8"],
    };
    const piModels = {
      defaultModel: sonnet,
      defaultThinkingLevel: "high",
      subagentModel: haiku,
      sideQuestionModel: haiku,
      subagentThinkingLevel: "low",
      hiddenModels: ["anthropic/claude-opus-4-8"],
    };

    it("moves the global fields to the default agent (pi when unset) and smallModel to quickTasks", () => {
      expect(migrateSettings({ models: legacy } as never)).toEqual({ models: { quickTasks: { harness: "pi", model: haiku }, agents: { pi: piModels } } });
      expect(migrateSettings({ agent: { defaultHarness: "claude" }, models: legacy } as never)).toEqual({
        agent: { defaultHarness: "claude" },
        models: { quickTasks: { harness: "claude", model: haiku }, agents: { claude: piModels } },
      });
      // smallModel null = automatic.
      expect(migrateSettings({ models: { smallModel: null } } as never)).toEqual({ models: { quickTasks: null } });
    });

    it("keeps values already under the agent and an existing quickTasks", () => {
      const quick = { harness: "claude", model: { provider: "anthropic", id: "haiku" } };
      const stored = { models: { defaultModel: sonnet, hiddenModels: ["x/y"], smallModel: haiku, quickTasks: quick, agents: { pi: { defaultModel: haiku }, codex: { hiddenModels: ["o/p"] } } } };
      expect(migrateSettings(stored as never)).toEqual({
        models: { quickTasks: quick, agents: { pi: { defaultModel: haiku, hiddenModels: ["x/y"] }, codex: { hiddenModels: ["o/p"] } } },
      });
    });

    it("migrates the database's legacy values on read and on the next write; an older client's patch lands under the default agent", () => {
      const dir = tempDir();
      new Store(dir, 0).flush();
      const db = openDatabase(join(dir, DB_FILE));
      db.prepare("INSERT INTO settings (id, data_json, updated_at) VALUES (1, ?, 1) ON CONFLICT (id) DO UPDATE SET data_json = excluded.data_json").run(
        JSON.stringify({ models: legacy }),
      );
      db.close();
      const store = new Store(dir, 0);
      expect(store.getSettings().models).toEqual({ quickTasks: { harness: "pi", model: haiku }, agents: { pi: piModels } });
      store.updateSettings({ general: { generateTitles: false } });
      expect(store.getSettingsOverrides().models).toEqual({ quickTasks: { harness: "pi", model: haiku }, agents: { pi: piModels } });
      // An older client still sends the global fields.
      store.updateSettings({ models: { defaultModel: haiku, hiddenModels: [], smallModel: null } } as never);
      expect(store.getSettingsOverrides().models).toEqual({ quickTasks: null, agents: { pi: { ...piModels, defaultModel: haiku, hiddenModels: [] } } });
    });

    it("deep-merges an agent's entry, replaces its hidden list and clears quickTasks with null", () => {
      const store = new Store(tempDir(), 0);
      store.updateSettings({ models: { agents: { pi: { defaultModel: sonnet, hiddenModels: ["a/b", "c/d"] } }, quickTasks: { harness: "pi", model: haiku } } });
      store.updateSettings({ models: { agents: { pi: { hiddenModels: ["e/f"] }, claude: { defaultModel: { provider: "anthropic", id: "opus" } } } } });
      expect(store.getSettings().models.agents).toEqual({
        pi: { defaultModel: sonnet, hiddenModels: ["e/f"] },
        claude: { defaultModel: { provider: "anthropic", id: "opus" } },
      });
      expect(store.getSettings().models.quickTasks).toEqual({ harness: "pi", model: haiku });
      store.updateSettings({ models: { quickTasks: null } });
      expect(store.getSettings().models.quickTasks).toBeNull();
    });
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
      { id: "c1", projectId: "p1", title: "Fix login", titleSource: "user", cwd: "/proj", pinned: true, pinOrder: 3, createdAt: 10, lastActivityAt: 20, layout: null, sortOrder: 0 },
      // sortOrder: the I-202 order migration that runs after the import.
      { id: "c2", projectId: null, title: "Fix login", titleSource: "auto", cwd: "/proj", pinned: false, createdAt: 10, lastActivityAt: 20, layout: null, sortOrder: 0 },
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
