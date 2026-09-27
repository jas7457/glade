/**
 * I-096: git worktrees per workspace — the git service against a temp repository, and the
 * workspace create/delete wiring (FakeHarness) plus the HTTP routes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    expect(await projectGitInfo(repo)).toEqual({ isRepo: true, branch: "main" });
    const plain = join(dir, "plain");
    mkdirSync(plain);
    expect(await projectGitInfo(plain)).toEqual({ isRepo: false, branch: null });
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
    expect(await (await call("GET", `/api/projects/${projectId}/git`)).json()).toEqual({ isRepo: true, branch: "main" });
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
