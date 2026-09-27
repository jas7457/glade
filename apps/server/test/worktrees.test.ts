/**
 * I-096: git worktrees per workspace — the git service against a temp repository, and the
 * workspace create/delete wiring (FakeHarness) plus the HTTP routes.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorktreeStatus } from "@glade/protocol";
import { createApp } from "../src/http/app.js";
import { HttpError } from "../src/services/app-service.js";
import { createWorktree, mergeWorktree, projectGitInfo, removeWorktree, slugify, worktreeStatus } from "../src/services/worktrees.js";
import { createTestEnv, flush, newChat, type TestEnv } from "./helpers.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A repo on `main` with one commit. */
function makeRepo(dir: string): string {
  const repo = join(dir, "My Repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  return realpathSync(repo);
}

function commitIn(folder: string, file: string, text: string): void {
  writeFileSync(join(folder, file), text);
  git(folder, "add", ".");
  git(folder, "commit", "-q", "-m", `add ${file}`);
}

const branches = (repo: string) => git(repo, "branch", "--format=%(refname:short)").split("\n");

describe("slugify", () => {
  it("makes short branch-safe slugs", () => {
    expect(slugify("Fix the sidebar!")).toBe("fix-the-sidebar");
    expect(slugify("Crème brûlée — v2")).toBe("creme-brulee-v2");
    expect(slugify("???")).toBe("");
    expect(slugify("a very long title that keeps going and going past the limit").length).toBeLessThanOrEqual(40);
  });
});

describe("worktrees service", () => {
  let dir: string;
  let repo: string;
  let wtDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "glade-wt-"));
    repo = makeRepo(dir);
    wtDir = join(dir, "data", "worktrees");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reports whether a folder is a git repo", async () => {
    expect(await projectGitInfo(repo)).toMatchObject({ isRepo: true, branch: "main" });
    const plain = join(dir, "plain");
    mkdirSync(plain);
    expect(await projectGitInfo(plain)).toEqual({ isRepo: false, branch: null, branches: [], uncommittedFiles: 0, uncommittedPaths: [] });
  });

  it("creates a worktree on a unique glade/ branch from the current branch", async () => {
    const a = await createWorktree({ folder: repo, worktreesDir: wtDir, name: "Fix login", fallback: "abc" });
    expect(a.worktree).toEqual({ path: a.cwd, branch: "glade/fix-login", baseRef: "main", repoRoot: repo });
    expect(a.cwd).toBe(join(realpathSync(wtDir), "my-repo", "fix-login"));
    expect(git(a.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("glade/fix-login");
    expect(existsSync(join(a.cwd, "a.txt"))).toBe(true);

    const b = await createWorktree({ folder: repo, worktreesDir: wtDir, name: "Fix login", fallback: "abc" });
    expect(b.worktree.branch).toBe("glade/fix-login-2");
    const c = await createWorktree({ folder: repo, worktreesDir: wtDir, name: "", fallback: "1234abcd" });
    expect(c.worktree.branch).toBe("glade/1234abcd");
  });

  it("rejects folders that aren't git repositories (or have no commits)", async () => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    await expect(createWorktree({ folder: plain, worktreesDir: wtDir, name: "x", fallback: "x" })).rejects.toMatchObject({ status: 400 });
    const empty = join(dir, "empty");
    mkdirSync(empty);
    git(empty, "init", "-q");
    await expect(createWorktree({ folder: empty, worktreesDir: wtDir, name: "x", fallback: "x" })).rejects.toThrow(/no commits/);
  });

  it("reports uncommitted files, commits ahead and whether it can merge", async () => {
    const { worktree } = await createWorktree({ folder: repo, worktreesDir: wtDir, name: "work", fallback: "x" });
    expect(await worktreeStatus(worktree)).toEqual<WorktreeStatus>({
      branch: "glade/work",
      baseRef: "main",
      exists: true,
      uncommittedFiles: 0,
      ahead: 0,
      mergeBlocker: null,
    });
    commitIn(worktree.path, "b.txt", "b\n");
    writeFileSync(join(worktree.path, "c.txt"), "untracked\n");
    writeFileSync(join(worktree.path, "a.txt"), "changed\n");
    expect(await worktreeStatus(worktree)).toMatchObject({ uncommittedFiles: 2, ahead: 1, mergeBlocker: null });

    writeFileSync(join(repo, "a.txt"), "dirty root\n");
    expect((await worktreeStatus(worktree)).mergeBlocker).toMatch(/uncommitted changes/);
    git(repo, "checkout", "-q", "--", "a.txt");
    git(repo, "checkout", "-q", "-b", "other");
    expect((await worktreeStatus(worktree)).mergeBlocker).toMatch(/on other, not main/);
  });

  it("keep: removes the folder, keeps the branch", async () => {
    const { worktree } = await createWorktree({ folder: repo, worktreesDir: wtDir, name: "keep me", fallback: "x" });
    writeFileSync(join(worktree.path, "dirty.txt"), "x\n");
    await removeWorktree(worktree, "keep");
    expect(existsSync(worktree.path)).toBe(false);
    expect(branches(repo)).toContain("glade/keep-me");
  });

  it("discard: removes the folder and deletes the branch, even with unmerged commits", async () => {
    const { worktree } = await createWorktree({ folder: repo, worktreesDir: wtDir, name: "throwaway", fallback: "x" });
    commitIn(worktree.path, "b.txt", "b\n");
    await removeWorktree(worktree, "discard");
    expect(existsSync(worktree.path)).toBe(false);
    expect(branches(repo)).not.toContain("glade/throwaway");
  });

  it("merge: merges into the base branch in the repo root, then deletes the branch", async () => {
    const { worktree } = await createWorktree({ folder: repo, worktreesDir: wtDir, name: "feature", fallback: "x" });
    commitIn(worktree.path, "b.txt", "b\n");
    await mergeWorktree(worktree);
    await removeWorktree(worktree, "merge");
    expect(existsSync(join(repo, "b.txt"))).toBe(true);
    expect(branches(repo)).toEqual(["main"]);
  });

  it("refuses to merge when the repo root has uncommitted changes (and changes nothing)", async () => {
    const { worktree } = await createWorktree({ folder: repo, worktreesDir: wtDir, name: "feature", fallback: "x" });
    commitIn(worktree.path, "b.txt", "b\n");
    writeFileSync(join(repo, "a.txt"), "dirty root\n");
    const err = await mergeWorktree(worktree).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 409, message: expect.stringMatching(/uncommitted changes/) });
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
  });

  it("aborts a conflicting merge and leaves the root as it was", async () => {
    const { worktree } = await createWorktree({ folder: repo, worktreesDir: wtDir, name: "feature", fallback: "x" });
    commitIn(worktree.path, "a.txt", "theirs\n");
    commitIn(repo, "a.txt", "ours\n");
    await expect(mergeWorktree(worktree)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/nothing was deleted/) });
    expect(git(repo, "status", "--porcelain")).toBe("");
  });
});

describe("carrying uncommitted changes into a new worktree (I-117)", () => {
  let dir: string;
  let repo: string;
  let wtDir: string;
  const BIN = Buffer.from([0, 1, 2, 255, 254, 0, 10, 13]);
  const BIN2 = Buffer.from([9, 0, 8, 0, 7, 255]);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "glade-carry-"));
    repo = makeRepo(dir);
    writeFileSync(join(repo, "del.txt"), "delete me\n");
    writeFileSync(join(repo, "old-name.txt"), "renamed content\n");
    writeFileSync(join(repo, "pic.bin"), BIN);
    writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "more");
    wtDir = join(dir, "data", "worktrees");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Every kind of change: modified (staged + unstaged), added, deleted, renamed, binary, untracked, ignored. */
  function makeDirty(): void {
    writeFileSync(join(repo, "a.txt"), "a\nstaged\n");
    git(repo, "add", "a.txt");
    writeFileSync(join(repo, "a.txt"), "a\nstaged\nunstaged\n");
    writeFileSync(join(repo, "added.txt"), "new file\n");
    git(repo, "add", "added.txt");
    unlinkSync(join(repo, "del.txt"));
    git(repo, "mv", "old-name.txt", "new-name.txt");
    writeFileSync(join(repo, "pic.bin"), BIN2);
    mkdirSync(join(repo, "notes", "deep"), { recursive: true });
    writeFileSync(join(repo, "notes", "deep", "todo.md"), "untracked\n");
    writeFileSync(join(repo, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync("a.txt", join(repo, "link-to-a"));
    writeFileSync(join(repo, "ignored.log"), "noise\n");
  }

  const snapshot = (root: string) => ({
    status: git(root, "status", "--porcelain=v1", "--untracked-files=all"),
    staged: git(root, "diff", "--cached", "--name-status", "-M"),
    stashes: git(root, "stash", "list"),
    a: readFileSync(join(root, "a.txt"), "utf8"),
    bin: readFileSync(join(root, "pic.bin")),
  });

  it("brings tracked changes (staged and not), binary files and untracked files; the project folder is untouched", async () => {
    makeDirty();
    const before = snapshot(repo);
    const { cwd } = await createWorktree({ folder: repo, worktreesDir: wtDir, name: "carry", fallback: "x", carryChanges: true });
    expect(snapshot(repo)).toEqual(before);
    expect(existsSync(join(repo, "ignored.log"))).toBe(true);

    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("a\nstaged\nunstaged\n");
    expect(git(cwd, "show", ":a.txt")).toBe("a\nstaged"); // the staged version stays staged
    expect(readFileSync(join(cwd, "added.txt"), "utf8")).toBe("new file\n");
    expect(existsSync(join(cwd, "del.txt"))).toBe(false);
    expect(existsSync(join(cwd, "old-name.txt"))).toBe(false);
    expect(readFileSync(join(cwd, "new-name.txt"), "utf8")).toBe("renamed content\n");
    expect(readFileSync(join(cwd, "pic.bin"))).toEqual(BIN2);
    expect(readFileSync(join(cwd, "notes", "deep", "todo.md"), "utf8")).toBe("untracked\n");
    expect(lstatSync(join(cwd, "run.sh")).mode & 0o111).not.toBe(0);
    expect(readlinkSync(join(cwd, "link-to-a"))).toBe("a.txt");
    expect(existsSync(join(cwd, "ignored.log"))).toBe(false);
    // Same picture in both folders (the branch line aside).
    expect(git(cwd, "status", "--porcelain=v1", "--untracked-files=all")).toBe(before.status);
    expect(git(cwd, "diff", "--cached", "--name-status", "-M")).toBe(before.staged);
  });

  it("an unstaged rename (delete + untracked file) carries over too", async () => {
    renameSync(join(repo, "old-name.txt"), join(repo, "moved.txt"));
    const { cwd } = await createWorktree({ folder: repo, worktreesDir: wtDir, name: "mv", fallback: "x", carryChanges: true });
    expect(existsSync(join(cwd, "old-name.txt"))).toBe(false);
    expect(readFileSync(join(cwd, "moved.txt"), "utf8")).toBe("renamed content\n");
    expect(existsSync(join(repo, "moved.txt"))).toBe(true);
  });

  it("is a no-op for a clean folder, and off by default", async () => {
    const clean = await createWorktree({ folder: repo, worktreesDir: wtDir, name: "clean", fallback: "x", carryChanges: true });
    expect(git(clean.cwd, "status", "--porcelain")).toBe("");
    makeDirty();
    const plain = await createWorktree({ folder: repo, worktreesDir: wtDir, name: "plain", fallback: "x" });
    expect(git(plain.cwd, "status", "--porcelain")).toBe("");
  });

  it("refuses a base other than the current branch", async () => {
    git(repo, "branch", "dev");
    makeDirty();
    await expect(createWorktree({ folder: repo, worktreesDir: wtDir, name: "x", fallback: "x", baseRef: "dev", carryChanges: true })).rejects.toMatchObject({ status: 400 });
    const ok = await createWorktree({ folder: repo, worktreesDir: wtDir, name: "y", fallback: "y", baseRef: "main", carryChanges: true });
    expect(readFileSync(join(ok.cwd, "added.txt"), "utf8")).toBe("new file\n");
  });

  it.skipIf(process.getuid?.() === 0)("removes the new worktree and branch when carrying fails", async () => {
    makeDirty();
    writeFileSync(join(repo, "secret.txt"), "unreadable\n");
    chmodSync(join(repo, "secret.txt"), 0o000);
    const before = snapshot(repo);
    try {
      const err = await createWorktree({ folder: repo, worktreesDir: wtDir, name: "fail", fallback: "x", carryChanges: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).message).toMatch(/Couldn't bring your uncommitted changes/);
      expect(branches(repo)).toEqual(["main"]);
      expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
      expect(existsSync(join(wtDir, "my-repo", "fail"))).toBe(false);
      expect(snapshot(repo)).toEqual(before);
    } finally {
      chmodSync(join(repo, "secret.txt"), 0o644);
    }
  });
});

describe("worktree workspaces", () => {
  let env: TestEnv;
  let repo: string;
  let projectId: string;
  beforeEach(() => {
    env = createTestEnv();
    repo = makeRepo(env.dir);
    projectId = env.service.createProject({ path: repo }).id;
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("creates the workspace in a new worktree; its sessions run there", async () => {
    const chat = await newChat(env, { projectId, prompt: "add dark mode", worktree: true });
    await flush();
    const ws = env.store.getWorkspace(chat.wid)!;
    expect(ws.worktree).toMatchObject({ branch: "glade/add-dark-mode", baseRef: "main", repoRoot: repo });
    expect(ws.cwd).toBe(ws.worktree!.path);
    expect(ws.cwd.startsWith(realpathSync(join(env.dir, "data", "worktrees")))).toBe(true);
    expect(chat.workspace.worktree).toEqual(ws.worktree);
    const tab = await env.service.createSession(chat.wid, {});
    const fake = [...env.harness.openSessions].find((s) => s.sessionRef === env.store.getSession(tab.session.id)!.sessionRef)!;
    expect(fake.cwd).toBe(ws.cwd);
    expect(await env.service.getWorktreeStatus(chat.wid)).toMatchObject({ branch: "glade/add-dark-mode", ahead: 0, uncommittedFiles: 0 });
  });

  it("normal workspaces don't get one; standalone and non-git chats can't", async () => {
    const plain = await newChat(env, { projectId });
    expect(env.store.getWorkspace(plain.wid)!.worktree).toBeUndefined();
    await expect(env.service.getWorktreeStatus(plain.wid)).rejects.toMatchObject({ status: 404 });
    await expect(newChat(env, { projectId: null, worktree: true })).rejects.toMatchObject({ status: 400 });
    const folder = join(env.dir, "not-git");
    mkdirSync(folder);
    const other = env.service.createProject({ path: folder });
    await expect(newChat(env, { projectId: other.id, worktree: true })).rejects.toMatchObject({ status: 400 });
    expect(env.service.listWorkspaces()).toHaveLength(1);
  });

  it("delete keeps the branch by default", async () => {
    const chat = await newChat(env, { projectId, prompt: "x", worktree: true });
    const wt = env.store.getWorkspace(chat.wid)!.worktree!;
    await env.service.deleteWorkspace(chat.wid);
    expect(env.store.getWorkspace(chat.wid)).toBeUndefined();
    expect(existsSync(wt.path)).toBe(false);
    expect(branches(repo)).toContain(wt.branch);
  });

  it("delete with merge merges first; a refused merge deletes nothing", async () => {
    const chat = await newChat(env, { projectId, prompt: "feature", worktree: true });
    const wt = env.store.getWorkspace(chat.wid)!.worktree!;
    commitIn(wt.path, "b.txt", "b\n");
    writeFileSync(join(repo, "a.txt"), "dirty\n");
    await expect(env.service.deleteWorkspace(chat.wid, "merge")).rejects.toMatchObject({ status: 409 });
    expect(env.store.getWorkspace(chat.wid)).toBeDefined();
    expect(existsSync(wt.path)).toBe(true);

    git(repo, "checkout", "-q", "--", "a.txt");
    await env.service.deleteWorkspace(chat.wid, "merge");
    expect(env.store.getWorkspace(chat.wid)).toBeUndefined();
    expect(existsSync(join(repo, "b.txt"))).toBe(true);
    expect(branches(repo)).toEqual(["main"]);
  });

  it("delete with discard removes the branch", async () => {
    const chat = await newChat(env, { projectId, prompt: "nope", worktree: true });
    const wt = env.store.getWorkspace(chat.wid)!.worktree!;
    commitIn(wt.path, "b.txt", "b\n");
    await env.service.deleteWorkspace(chat.wid, "discard");
    expect(existsSync(wt.path)).toBe(false);
    expect(branches(repo)).toEqual(["main"]);
  });

  it("carryChanges: the new chat's worktree starts with the project folder's uncommitted changes", async () => {
    writeFileSync(join(repo, "a.txt"), "edited\n");
    writeFileSync(join(repo, "new.txt"), "untracked\n");
    const chat = await newChat(env, { projectId, prompt: "carry", worktree: true, carryChanges: true });
    const ws = env.store.getWorkspace(chat.wid)!;
    expect(readFileSync(join(ws.cwd, "a.txt"), "utf8")).toBe("edited\n");
    expect(readFileSync(join(ws.cwd, "new.txt"), "utf8")).toBe("untracked\n");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("edited\n");
  });

  it("removes the worktree when the first session fails to start", async () => {
    env.harness.openSession = () => Promise.reject(new Error("boom"));
    await expect(newChat(env, { projectId, prompt: "fails", worktree: true })).rejects.toThrow("boom");
    expect(branches(repo)).toEqual(["main"]);
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("HTTP: project git info, worktree status, delete with ?worktree=", async () => {
    const { app } = createApp({ service: env.service });
    const call = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { host: "127.0.0.1:4317", ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    expect(await (await call("GET", `/api/projects/${projectId}/git`)).json()).toMatchObject({ isRepo: true, branch: "main" });
    expect((await call("POST", "/api/workspaces", { projectId, worktree: "yes" })).status).toBe(400);
    const created = await call("POST", "/api/workspaces", { projectId, prompt: "via http", worktree: true });
    expect(created.status).toBe(200);
    const { workspace } = (await created.json()) as { workspace: { id: string; worktree: { branch: string } } };
    expect(workspace.worktree.branch).toBe("glade/via-http");
    expect(await (await call("GET", `/api/workspaces/${workspace.id}/worktree`)).json()).toMatchObject({ branch: "glade/via-http", exists: true });
    expect((await call("DELETE", `/api/workspaces/${workspace.id}?worktree=bogus`)).status).toBe(400);
    expect((await call("DELETE", `/api/workspaces/${workspace.id}?worktree=discard`)).status).toBe(204);
    expect(branches(repo)).toEqual(["main"]);
  });
});
