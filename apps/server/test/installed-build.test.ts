/**
 * I-197: the installed-build watcher (fake fs, no timers): a newer stamp in the app bundle is
 * reported once, the same build isn't, a missing/half-written file keeps the last answer, dev
 * servers never watch; and `installed` in `GET /api/version` + the checker's change event.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BuildInfo, VersionStatus } from "@glade/protocol";
import { InstalledBuildWatcher, type StampFs } from "../src/services/installed-build.js";
import { UpdateChecker, type GitRun } from "../src/services/update-check.js";

const RUNNING: BuildInfo = { commit: "a".repeat(40), shortCommit: "aaaaaaa", builtAt: "2026-10-05T10:00:00.000Z", dirty: false, repoPath: "/src/glade", kind: "release" };
const NEWER: BuildInfo = { ...RUNNING, commit: "b".repeat(40), shortCommit: "bbbbbbb", builtAt: "2026-10-05T11:00:00.000Z" };
const PATH = "/Applications/Glade.app/Contents/Resources/app/build.json";

/** A one-file fs: `write` changes the content and its change token; `remove` makes it unreadable. */
function fakeFs(initial: BuildInfo | string | null) {
  let content: string | null = initial === null ? null : typeof initial === "string" ? initial : JSON.stringify(initial);
  let version = 0;
  let reads = 0;
  const fs: StampFs = {
    stat: (path) => (path === PATH && content !== null ? `v${version}` : null),
    read: (path) => {
      reads++;
      if (path !== PATH || content === null) throw new Error("ENOENT");
      return content;
    },
  };
  return {
    fs,
    write(next: BuildInfo | string) {
      content = typeof next === "string" ? next : JSON.stringify(next);
      version++;
    },
    remove() {
      content = null;
    },
    get reads() {
      return reads;
    },
  };
}

function watcher(file: ReturnType<typeof fakeFs>, running: BuildInfo | null = RUNNING) {
  const changes: Array<BuildInfo | null> = [];
  const w = new InstalledBuildWatcher({ running, path: PATH, fs: file.fs, onChange: (b) => changes.push(b) });
  return { w, changes };
}

describe("InstalledBuildWatcher", () => {
  it("reports nothing while the bundle holds the running build", () => {
    const file = fakeFs(RUNNING);
    const { w, changes } = watcher(file);
    expect(w.poll()).toBeNull();
    expect(w.installed()).toBeNull();
    expect(changes).toEqual([]);
  });

  it("reports a newer build once, and reads the file only when it changed", () => {
    const file = fakeFs(RUNNING);
    const { w, changes } = watcher(file);
    w.poll();
    expect(file.reads).toBe(1);
    w.poll();
    expect(file.reads).toBe(1);
    file.write(NEWER);
    expect(w.poll()).toEqual(NEWER);
    expect(w.poll()).toEqual(NEWER);
    expect(w.installed()).toEqual(NEWER);
    expect(changes).toEqual([NEWER]);
  });

  it("a different build time of the same commit counts as a new build", () => {
    const file = fakeFs(RUNNING);
    const { w } = watcher(file);
    file.write({ ...RUNNING, builtAt: "2026-10-05T12:00:00.000Z" });
    expect(w.poll()?.builtAt).toBe("2026-10-05T12:00:00.000Z");
  });

  it("reports an even newer build again, and clears when the running build is put back", () => {
    const file = fakeFs(RUNNING);
    const { w, changes } = watcher(file);
    file.write(NEWER);
    w.poll();
    const newest = { ...NEWER, commit: "c".repeat(40), shortCommit: "ccccccc" };
    file.write(newest);
    w.poll();
    file.write(RUNNING);
    w.poll();
    expect(changes).toEqual([NEWER, newest, null]);
  });

  it("keeps the last answer while the file is missing (between the renames) or half-written", () => {
    const file = fakeFs(RUNNING);
    const { w, changes } = watcher(file);
    file.write(NEWER);
    w.poll();
    file.remove();
    expect(w.poll()).toEqual(NEWER);
    file.write('{"commit":');
    expect(w.poll()).toEqual(NEWER);
    expect(changes).toEqual([NEWER]);
  });

  it("an old bundle without a stamp file, or a stamp of null, is not a new build", () => {
    expect(watcher(fakeFs(null)).w.poll()).toBeNull();
    expect(watcher(fakeFs("null")).w.poll()).toBeNull();
  });

  it("never watches a dev server or one without a build", () => {
    const file = fakeFs(NEWER);
    const dev = watcher(file, { ...RUNNING, kind: "dev" });
    expect(dev.w.enabled).toBe(false);
    expect(dev.w.poll()).toBeNull();
    expect(watcher(file, null).w.poll()).toBeNull();
    expect(file.reads).toBe(0);
  });

  it("reads the real file next to it (node fs)", () => {
    const dir = mkdtempSync(join(tmpdir(), "glade-installed-"));
    try {
      const path = join(dir, "build.json");
      writeFileSync(path, JSON.stringify(RUNNING));
      const w = new InstalledBuildWatcher({ running: RUNNING, path });
      expect(w.poll()).toBeNull();
      writeFileSync(path, JSON.stringify(NEWER) + "\n");
      expect(w.poll()).toEqual(NEWER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("UpdateChecker with an installed build", () => {
  const git: GitRun = async () => `${RUNNING.commit}\trefs/heads/main\n`;

  it("adds `installed` to the status when there is one", () => {
    let installed: BuildInfo | null = null;
    const c = new UpdateChecker({ build: () => RUNNING, installed: () => installed, git, exists: () => true });
    expect(c.status()).toEqual({ build: RUNNING, check: null, checking: false });
    installed = NEWER;
    expect(c.status().installed).toEqual(NEWER);
  });

  it("tells listeners when a check finished", async () => {
    const c = new UpdateChecker({ build: () => RUNNING, git, exists: () => true });
    const seen: VersionStatus[] = [];
    const off = c.onChange((s) => seen.push(s));
    await c.check();
    expect(seen.map((s) => s.check?.state)).toEqual(["up-to-date"]);
    off();
    await c.check();
    expect(seen).toHaveLength(1);
  });
});
