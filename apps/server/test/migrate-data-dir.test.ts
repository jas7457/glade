/**
 * I-059: the first start after the rename copies `…/pi-ui` into `…/Glade` (never moving it), minus
 * the per-server runtime state. Runs against a temp HOME-like layout, never the real folders.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateLegacyDataDir } from "../src/store/migrate-data-dir.js";
import { Store } from "../src/store/store.js";

let home: string;
let oldDir: string;
let newDir: string;

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "glade-migrate-home-"));
  oldDir = join(home, "Library", "Application Support", "pi-ui");
  newDir = join(home, "Library", "Application Support", "Glade");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function seedOld(): void {
  const scratch = join(oldDir, "scratch");
  write(join(oldDir, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "p1", name: "repo", path: "/src/repo", sortOrder: 0, createdAt: 1 }] }));
  write(
    join(oldDir, "workspaces.json"),
    JSON.stringify({
      version: 1,
      workspaces: [
        { id: "w1", projectId: null, cwd: scratch, title: "Scratch chat" },
        { id: "w2", projectId: "p1", cwd: "/src/repo", title: "Repo chat" },
        { id: "w3", projectId: null, cwd: `${scratch}-other`, title: "Not scratch" },
      ],
      sessions: [],
    }),
  );
  write(join(oldDir, "settings.json"), JSON.stringify({ appearance: { theme: "dark" } }));
  write(join(oldDir, "agents.json"), "{}");
  write(join(oldDir, "session-summaries.json"), "{}");
  write(join(oldDir, "search-index.json"), "{}");
  write(join(oldDir, "chats.json"), "[]");
  write(join(scratch, "notes.txt"), "hello");
  write(join(oldDir, "servers", "123.json"), "{}");
  write(join(oldDir, "leases", "s1.json"), "{}");
  mkdirSync(join(oldDir, "workspaces.json.lock"));
  write(join(oldDir, "server.lock"), "1");
}

describe("migrateLegacyDataDir", () => {
  it("copies the data (not the runtime state) and leaves the old folder untouched", () => {
    seedOld();
    const before = readdirSync(oldDir).sort();
    const result = migrateLegacyDataDir(oldDir, newDir);
    expect(result).toEqual({
      from: oldDir,
      to: newDir,
      copied: [
        "agents.json",
        "chats.json",
        "projects.json",
        "scratch",
        "search-index.json",
        "session-summaries.json",
        "settings.json",
        "workspaces.json",
      ],
    });
    expect(readdirSync(newDir).sort()).toEqual(result!.copied);
    expect(readFileSync(join(newDir, "scratch", "notes.txt"), "utf8")).toBe("hello");
    expect(JSON.parse(readFileSync(join(newDir, "settings.json"), "utf8"))).toEqual({ appearance: { theme: "dark" } });
    // Old folder: still all there (a backup).
    expect(readdirSync(oldDir).sort()).toEqual(before);
    // Standalone chats now run in the copied scratch folder; others are unchanged.
    const ws = JSON.parse(readFileSync(join(newDir, "workspaces.json"), "utf8")).workspaces;
    expect(ws.map((w: { cwd: string }) => w.cwd)).toEqual([join(newDir, "scratch"), "/src/repo", `${join(oldDir, "scratch")}-other`]);
    // No staging folder left behind.
    expect(readdirSync(join(home, "Library", "Application Support")).sort()).toEqual(["Glade", "pi-ui"]);
  });

  it("the store reads the copied data", () => {
    seedOld();
    migrateLegacyDataDir(oldDir, newDir);
    const store = new Store(newDir);
    expect(store.listProjects().map((p) => p.name)).toEqual(["repo"]);
    store.dispose();
  });

  it("does nothing when the new folder exists", () => {
    seedOld();
    mkdirSync(newDir, { recursive: true });
    write(join(newDir, "settings.json"), "{}");
    expect(migrateLegacyDataDir(oldDir, newDir)).toBeNull();
    expect(readdirSync(newDir)).toEqual(["settings.json"]);
  });

  it("does nothing when there is no old folder", () => {
    expect(migrateLegacyDataDir(oldDir, newDir)).toBeNull();
    expect(existsSync(newDir)).toBe(false);
  });

  it("runs once: a second call is a no-op", () => {
    seedOld();
    expect(migrateLegacyDataDir(oldDir, newDir)).not.toBeNull();
    expect(migrateLegacyDataDir(oldDir, newDir)).toBeNull();
  });
});
