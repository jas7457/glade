/**
 * Unit tests for the `pnpm dev:agent` sandbox helpers (run by `pnpm test` via `node --test`).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  addOwner,
  collectSessionRefs,
  deleteSandboxSessions,
  env,
  isStale,
  parseArgs,
  pickPorts,
  piSessionFolderName,
  pruneDeadOwners,
  removeOwner,
  startDecision,
  sweep,
  writeState,
} from "./lib.mjs";

const DAY = 24 * 60 * 60 * 1000;
const alive = (pids) => (pid) => pids.includes(pid);

describe("env (I-059)", () => {
  it("prefers GLADE_*, falls back to PI_UI_*, ignores empty values", () => {
    assert.equal(env("PORT", { GLADE_PORT: "1", PI_UI_PORT: "2" }), "1");
    assert.equal(env("PORT", { GLADE_PORT: "", PI_UI_PORT: "2" }), "2");
    assert.equal(env("PORT", {}), undefined);
  });
});

describe("parseArgs", () => {
  it("defaults", () => {
    assert.deepEqual(parseArgs([]), { name: "agent", real: false, keep: false, stop: false, sweep: false, help: false });
  });
  it("reads flags and --name in both forms", () => {
    assert.equal(parseArgs(["--name", "tabs"]).name, "tabs");
    assert.equal(parseArgs(["--name=tabs-2"]).name, "tabs-2");
    const a = parseArgs(["--", "--name", "x", "--real", "--keep"]);
    assert.equal(a.real, true);
    assert.equal(a.keep, true);
  });
  it("rejects unsafe names and unknown flags", () => {
    assert.throws(() => parseArgs(["--name", "../etc"]));
    assert.throws(() => parseArgs(["--name", ".hidden"]));
    assert.throws(() => parseArgs(["--name"]));
    assert.throws(() => parseArgs(["--bogus"]));
  });
});

describe("ref-counting", () => {
  const base = { owners: [] };
  it("adds owners once and removes them", () => {
    let s = addOwner(base, 10, 1);
    s = addOwner(s, 10, 2);
    s = addOwner(s, 11, 3);
    assert.deepEqual(s.owners, [
      { pid: 10, since: 1 },
      { pid: 11, since: 3 },
    ]);
    assert.deepEqual(removeOwner(s, 10).owners, [{ pid: 11, since: 3 }]);
    assert.deepEqual(removeOwner(removeOwner(s, 10), 11).owners, []);
    assert.deepEqual(base.owners, [], "does not mutate");
  });
  it("prunes dead owners", () => {
    const s = { owners: [{ pid: 1, since: 0 }, { pid: 2, since: 0 }] };
    assert.deepEqual(pruneDeadOwners(s, alive([2])).owners, [{ pid: 2, since: 0 }]);
  });
});

describe("startDecision", () => {
  it("creates, joins a live sandbox, reclaims a dead one", () => {
    assert.equal(startDecision(null, alive([])), "create");
    assert.equal(startDecision({ supervisorPid: 5, owners: [] }, alive([5])), "join");
    assert.equal(startDecision({ supervisorPid: 5, owners: [{ pid: 6 }] }, alive([6])), "reclaim");
    assert.equal(startDecision({ supervisorPid: null, owners: [] }, alive([])), "reclaim");
  });
});

describe("isStale (sweep decision)", () => {
  const now = 10 * DAY;
  it("keeps sandboxes with a live owner, whatever their age", () => {
    const state = { owners: [{ pid: 1 }], supervisorPid: 2, updatedAt: 0 };
    assert.equal(isStale({ state, mtimeMs: 0 }, { now, isAlive: alive([1]) }), false);
    assert.equal(isStale({ state, mtimeMs: 0 }, { now, isAlive: alive([1]), force: true }), false);
  });
  it("removes ownerless sandboxes older than a day", () => {
    const state = { owners: [{ pid: 1 }], supervisorPid: 2, updatedAt: now - DAY - 1 };
    assert.equal(isStale({ state, mtimeMs: 0 }, { now, isAlive: alive([]) }), true);
  });
  it("removes a crashed sandbox (dead supervisor, not kept) right away", () => {
    const state = { owners: [{ pid: 1 }], supervisorPid: 2, updatedAt: now - 1000 };
    assert.equal(isStale({ state, mtimeMs: now }, { now, isAlive: alive([]) }), true);
    assert.equal(isStale({ state: { ...state, keep: true }, mtimeMs: now }, { now, isAlive: alive([]) }), false);
  });
  it("keeps recent ownerless sandboxes unless forced", () => {
    const state = { owners: [], supervisorPid: null, updatedAt: now - 1000 };
    assert.equal(isStale({ state, mtimeMs: now - 1000 }, { now, isAlive: alive([]) }), false);
    assert.equal(isStale({ state, mtimeMs: now - 1000 }, { now, isAlive: alive([]), force: true }), true);
  });
  it("judges folders without sandbox.json by mtime", () => {
    assert.equal(isStale({ state: null, mtimeMs: now - 2 * DAY }, { now, isAlive: alive([]) }), true);
    assert.equal(isStale({ state: null, mtimeMs: now - 60_000 }, { now, isAlive: alive([]) }), false);
  });
});

describe("collectSessionRefs", () => {
  const root = "/home/u/.pi/agent/sessions";
  it("returns absolute .jsonl refs inside the sessions root only", () => {
    const workspaces = {
      version: 1,
      workspaces: [],
      sessions: [
        { sessionRef: `${root}/--tmp-repo--/a.jsonl` },
        { sessionRef: `${root}/--tmp-repo--/a.jsonl` }, // duplicate
        { sessionRef: null },
        { sessionRef: "fake-session-1" },
        { sessionRef: `${root}/--tmp-repo--` }, // a folder, never
        { sessionRef: `${root}/x.jsonl` }, // not inside a --cwd-- folder
        { sessionRef: `${root}/--a--/../../../../etc/passwd.jsonl` },
        { sessionRef: "/etc/other.jsonl" },
      ],
    };
    const chats = { chats: [{ sessionRef: `${root}/--old--/b.jsonl` }] };
    assert.deepEqual(collectSessionRefs([workspaces, chats, null, "garbage"], root), [
      `${root}/--old--/b.jsonl`,
      `${root}/--tmp-repo--/a.jsonl`,
    ]);
  });
});

describe("piSessionFolderName", () => {
  it("matches pi's naming", () => {
    assert.equal(piSessionFolderName("/private/tmp/glade-sandbox/a/repo"), "--private-tmp-glade-sandbox-a-repo--");
  });
});

describe("pickPorts", () => {
  it("skips reserved and duplicate ports", async () => {
    const seq = [4317, 6000, 6000, 5317, 6001];
    assert.deepEqual(await pickPorts(2, async () => seq.shift()), [6000, 6001]);
  });
  it("skips ports other sandboxes recorded", async () => {
    const seq = [7000, 7001, 7002];
    assert.deepEqual(await pickPorts(1, async () => seq.shift(), [7000, 7001]), [7002]);
  });
});

describe("filesystem cleanup", () => {
  const tmp = mkdtempSync(join(tmpdir(), "glade-sandbox-test-"));
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it("deletes only the session files the sandbox referenced, and empty folders", () => {
    const sessions = join(tmp, "sessions");
    const own = join(sessions, "--sandbox-repo--");
    const shared = join(sessions, "--glade--");
    mkdirSync(own, { recursive: true });
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(own, "a.jsonl"), "{}");
    writeFileSync(join(shared, "mine.jsonl"), "{}");
    writeFileSync(join(shared, "users-own.jsonl"), "{}");
    const box = join(tmp, "box");
    mkdirSync(join(box, "data"), { recursive: true });
    writeFileSync(
      join(box, "data", "workspaces.json"),
      JSON.stringify({ sessions: [{ sessionRef: join(own, "a.jsonl") }, { sessionRef: join(shared, "mine.jsonl") }] }),
    );
    const deleted = deleteSandboxSessions(box, sessions);
    assert.equal(deleted.length, 2);
    assert.equal(existsSync(own), false, "empty folder removed");
    assert.equal(existsSync(join(shared, "users-own.jsonl")), true, "unrelated session kept");
  });

  it("removes the sandbox's own empty session folders but never non-empty ones", () => {
    const sessions = join(tmp, "sessions2");
    const box = join(tmp, "box2");
    mkdirSync(join(box, "data"), { recursive: true });
    const real = realpathSync(box);
    const repoFolder = join(sessions, piSessionFolderName(join(real, "repo")));
    const scratchFolder = join(sessions, piSessionFolderName(join(real, "data", "scratch")));
    mkdirSync(repoFolder, { recursive: true });
    mkdirSync(scratchFolder, { recursive: true });
    writeFileSync(join(scratchFolder, "unknown.jsonl"), "{}");
    deleteSandboxSessions(box, sessions);
    assert.equal(existsSync(repoFolder), false);
    assert.equal(existsSync(join(scratchFolder, "unknown.jsonl")), true);
  });

  it("sweeps ownerless old sandboxes and keeps live or recent ones", () => {
    const root = join(tmp, "root");
    const mk = (name, state, ageMs) => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      if (state) writeState(dir, state);
      const t = (Date.now() - ageMs) / 1000;
      utimesSync(dir, t, t);
      return dir;
    };
    const now = Date.now();
    mk("old-dead", { owners: [{ pid: 999_999_999, since: 0 }], supervisorPid: null }, 2 * DAY);
    mk("old-live", { owners: [{ pid: process.pid, since: 0 }], supervisorPid: null }, 2 * DAY);
    mk("recent-dead", { owners: [], supervisorPid: null }, 1000);
    mk("orphan", null, 2 * DAY);
    // writeState stamps updatedAt=now; sweep as if two days had passed.
    const removed = sweep({ root, now: now + 2 * DAY }).sort();
    assert.deepEqual(removed, ["old-dead", "orphan", "recent-dead"].sort());
    assert.equal(existsSync(join(root, "old-live")), true);
  });

  it("forced sweep ignores age but never removes a live sandbox", () => {
    const root = join(tmp, "root2");
    mkdirSync(join(root, "a"), { recursive: true });
    writeState(join(root, "a"), { owners: [], supervisorPid: null });
    mkdirSync(join(root, "b"), { recursive: true });
    writeState(join(root, "b"), { owners: [{ pid: process.pid, since: 0 }], supervisorPid: null });
    assert.deepEqual(sweep({ root }), []);
    assert.deepEqual(sweep({ root, force: true }), ["a"]);
    assert.equal(existsSync(join(root, "b")), true);
  });
});
