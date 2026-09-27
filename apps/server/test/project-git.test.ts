/**
 * I-105: git in a project's own folder for the new-chat context bar — branches, uncommitted files,
 * checkout (refused while dirty or while a local chat is working), creating branches, and
 * worktrees from a chosen base branch / with a chosen name. Against temp repositories.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { checkoutBranch, createBranch, projectGitInfo } from "../src/services/project-git.js";
import { createWorktree } from "../src/services/worktrees.js";
import { createTestEnv, newChat, until, type TestEnv } from "./helpers.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A repo on `main` with one commit, plus `older` (older commit date) and `newer` branches. */
function makeRepo(dir: string): string {
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  const commit = (file: string, date: string) => {
    writeFileSync(join(repo, file), `${file}\n`);
    git(repo, "add", ".");
    execFileSync("git", ["commit", "-q", "-m", file], { cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
  };
  commit("a.txt", "2020-01-01T00:00:00Z");
  git(repo, "checkout", "-q", "-b", "older");
  commit("older.txt", "2021-01-01T00:00:00Z");
  git(repo, "checkout", "-q", "-b", "newer", "main");
  commit("newer.txt", "2022-01-01T00:00:00Z");
  git(repo, "checkout", "-q", "-b", "feature", "main");
  git(repo, "checkout", "-q", "main");
  return realpathSync(repo);
}

describe("project git", () => {
  let dir: string;
  let repo: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "glade-pg-"));
    repo = makeRepo(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists branches: current, default, then newest commit first", async () => {
    git(repo, "checkout", "-q", "feature");
    const info = await projectGitInfo(repo);
    expect(info.branch).toBe("feature");
    expect(info.branches.map((b) => b.name)).toEqual(["feature", "main", "newer", "older"]);
    expect(info.branches[0]).toMatchObject({ current: true, isDefault: false });
    expect(info.branches[1]).toMatchObject({ current: false, isDefault: true });
    expect(info.branches[2]!.committedAt).toBe(Date.parse("2022-01-01T00:00:00Z"));
    expect(info).toMatchObject({ uncommittedFiles: 0, uncommittedPaths: [] });
  });

  it("counts uncommitted files, untracked ones included", async () => {
    writeFileSync(join(repo, "a.txt"), "changed\n");
    writeFileSync(join(repo, "new file.txt"), "x\n");
    const info = await projectGitInfo(repo);
    expect(info.uncommittedFiles).toBe(2);
    expect(info.uncommittedPaths.sort()).toEqual(["a.txt", "new file.txt"]);
  });

  it("checks out a clean folder; refuses when dirty and changes nothing", async () => {
    const info = await checkoutBranch(repo, "newer");
    expect(info.branch).toBe("newer");
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("newer");

    writeFileSync(join(repo, "untracked.txt"), "x\n");
    await expect(checkoutBranch(repo, "main")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("untracked.txt") });
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("newer");
  });

  it("rejects unknown branches and option-like names", async () => {
    await expect(checkoutBranch(repo, "nope")).rejects.toMatchObject({ status: 400 });
    await expect(checkoutBranch(repo, "--orphan")).rejects.toMatchObject({ status: 400 });
  });

  it("creates branches (optionally checked out, keeping uncommitted changes); validates names", async () => {
    writeFileSync(join(repo, "a.txt"), "wip\n");
    const info = await createBranch(repo, "fix/login", true);
    expect(info.branch).toBe("fix/login");
    expect(info.uncommittedFiles).toBe(1); // carried along

    const other = await createBranch(repo, "later", false);
    expect(other.branch).toBe("fix/login");
    expect(other.branches.map((b) => b.name)).toContain("later");

    await expect(createBranch(repo, "later", false)).rejects.toMatchObject({ status: 409 });
    for (const bad of ["", "has space", "-x", "a..b", "HEAD", "x.lock", " lead"]) {
      await expect(createBranch(repo, bad, true)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("worktrees start from a chosen base branch and can be named", async () => {
    const wtDir = join(dir, "data", "worktrees");
    const a = await createWorktree({ folder: repo, worktreesDir: wtDir, name: "x", fallback: "f", baseRef: "newer" });
    expect(a.worktree).toMatchObject({ branch: "glade/x", baseRef: "newer" });
    expect(git(a.cwd, "log", "-1", "--format=%s")).toBe("newer.txt");
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main"); // no checkout in the project

    const b = await createWorktree({ folder: repo, worktreesDir: wtDir, name: "x", fallback: "f", branch: "feat/my-thing" });
    expect(b.worktree).toMatchObject({ branch: "feat/my-thing", baseRef: "main" });
    expect(git(b.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/my-thing");

    await expect(createWorktree({ folder: repo, worktreesDir: wtDir, name: "y", fallback: "f", baseRef: "nope" })).rejects.toMatchObject({ status: 400 });
    await expect(createWorktree({ folder: repo, worktreesDir: wtDir, name: "y", fallback: "f", branch: "bad name" })).rejects.toMatchObject({ status: 400 });
    await expect(createWorktree({ folder: repo, worktreesDir: wtDir, name: "y", fallback: "f", branch: "older" })).rejects.toMatchObject({ status: 409 });
  });
});

describe("project git routes", () => {
  let env: TestEnv;
  let repo: string;
  let projectId: string;
  let call: (method: string, path: string, body?: unknown) => Promise<Response>;
  beforeEach(() => {
    env = createTestEnv();
    repo = makeRepo(env.dir);
    projectId = env.service.createProject({ path: repo }).id;
    const { app } = createApp({ service: env.service });
    call = async (method, path, body) =>
      app.request(path, {
        method,
        headers: { host: "127.0.0.1:4317", ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("checkout, branch, and worktree options over HTTP", async () => {
    const info = (await (await call("GET", `/api/projects/${projectId}/git`)).json()) as { branches: { name: string }[] };
    expect(info.branches.map((b) => b.name)).toEqual(["main", "newer", "older", "feature"]);
    expect((await call("POST", `/api/projects/${projectId}/git/checkout`, {})).status).toBe(400);
    const res = await call("POST", `/api/projects/${projectId}/git/checkout`, { branch: "older" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { branch: string }).branch).toBe("older");
    expect((await call("POST", `/api/projects/${projectId}/git/branch`, { name: "bad name", checkout: true })).status).toBe(400);
    expect((await call("POST", `/api/projects/${projectId}/git/branch`, { name: "new-one", checkout: "yes" })).status).toBe(400);
    const created = await call("POST", `/api/projects/${projectId}/git/branch`, { name: "new-one", checkout: true });
    expect(((await created.json()) as { branch: string }).branch).toBe("new-one");

    writeFileSync(join(repo, "a.txt"), "dirty\n");
    const refused = await call("POST", `/api/projects/${projectId}/git/checkout`, { branch: "main" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain("a.txt");
    // Commit in the project folder (the dialog's "Commit…"), then the switch works.
    expect((await call("POST", `/api/projects/nope/changes/commit`, { message: "x" })).status).toBe(404);
    expect((await call("POST", `/api/projects/${projectId}/changes/commit`, { message: "wip" })).status).toBe(200);
    expect((await call("POST", `/api/projects/${projectId}/git/checkout`, { branch: "main" })).status).toBe(200);
    expect(git(repo, "log", "-1", "--format=%s", "new-one")).toBe("wip");

    expect((await call("POST", "/api/workspaces", { projectId, baseRef: "main" })).status).toBe(400); // needs worktree
    const wt = await call("POST", "/api/workspaces", { projectId, worktree: true, baseRef: "newer", branch: "chosen/name" });
    expect(wt.status).toBe(200);
    const { workspace } = (await wt.json()) as { workspace: { worktree: { branch: string; baseRef: string } } };
    expect(workspace.worktree).toMatchObject({ branch: "chosen/name", baseRef: "newer" });
  });

  it("refuses to switch while a chat works in the project folder (worktree chats don't count)", async () => {
    env.harness.eventDelayMs = 20;
    const local = await newChat(env, { projectId, prompt: "slow local" });
    await until(() => env.service.listSessions().some((s) => s.id === local.sid && s.running));
    await expect(env.service.checkoutProjectBranch(projectId, "older")).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("working in the project folder"),
    });
    await expect(env.service.createProjectBranch(projectId, "while-busy", true)).rejects.toMatchObject({ status: 409 });
    // Creating without checking out is fine.
    await expect(env.service.createProjectBranch(projectId, "side", false)).resolves.toMatchObject({ branch: "main" });
    await until(() => !env.service.listSessions().some((s) => s.running), 5000);

    const wt = await newChat(env, { projectId, prompt: "slow worktree", worktree: true });
    await until(() => env.service.listSessions().some((s) => s.id === wt.sid && s.running));
    await expect(env.service.checkoutProjectBranch(projectId, "older")).resolves.toMatchObject({ branch: "older" });
    await until(() => !env.service.listSessions().some((s) => s.running), 5000);
  });
});
