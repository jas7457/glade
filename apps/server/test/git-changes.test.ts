/**
 * GitChangesService (I-097) against throwaway git repositories, plus the HTTP routes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitChangesResponse, GitChangesResponse, GitFileDiffResponse, Project } from "@glade/protocol";
import { createApp } from "../src/http/app.js";
import { GitChangesService, cleanCommitMessage, isSafeRelativePath, parseUnifiedDiff } from "../src/services/git-changes.js";
import { createTestEnv, newChat, type TestEnv } from "./helpers.js";

let dir: string;
let repo: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "glade-git-")));
  repo = join(dir, "repo");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "b.txt"), "bee\n");
  writeFileSync(join(repo, "c.txt"), "sea\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function files(res: GitChangesResponse) {
  if (!res.isRepo) throw new Error("not a repo");
  return Object.fromEntries(res.files.map((f) => [f.path, f]));
}

describe("GitChangesService", () => {
  it("lists every kind of change with +/− counts", async () => {
    writeFileSync(join(repo, "a.txt"), "one\n2\nthree\nfour\n");
    unlinkSync(join(repo, "b.txt"));
    git("mv", "c.txt", "d.txt");
    writeFileSync(join(repo, "new.txt"), "x\ny");
    writeFileSync(join(repo, "staged.txt"), "s\n");
    git("add", "staged.txt");
    writeFileSync(join(repo, "img.bin"), Buffer.from([0, 1, 2, 0]));
    const res = await new GitChangesService().status(repo);
    expect(res).toMatchObject({ isRepo: true, branch: "main", root: repo, prefix: "", truncated: false });
    const byPath = files(res);
    expect(byPath["a.txt"]).toMatchObject({ kind: "modified", added: 2, removed: 1, binary: false });
    expect(byPath["b.txt"]).toMatchObject({ kind: "deleted", added: 0, removed: 1 });
    expect(byPath["d.txt"]).toMatchObject({ kind: "renamed", oldPath: "c.txt", added: 0, removed: 0 });
    expect(byPath["new.txt"]).toMatchObject({ kind: "untracked", added: 2, removed: 0 });
    expect(byPath["staged.txt"]).toMatchObject({ kind: "added", added: 1 });
    expect(byPath["img.bin"]).toMatchObject({ kind: "untracked", binary: true, added: null });
  });

  it("says when the folder isn't a repository", async () => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    expect(await new GitChangesService().status(plain)).toEqual({ isRepo: false });
    expect(await new GitChangesService().status(join(dir, "missing"))).toEqual({ isRepo: false });
    await expect(new GitChangesService().diff(plain, "a.txt")).rejects.toMatchObject({ status: 409 });
  });

  it("only lists changes under a subfolder workspace", async () => {
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "sub", "in.txt"), "in\n");
    writeFileSync(join(repo, "a.txt"), "changed\n");
    const res = await new GitChangesService().status(join(repo, "sub"));
    expect(res).toMatchObject({ prefix: "sub/" });
    expect(Object.keys(files(res))).toEqual(["sub/in.txt"]);
  });

  it("diffs tracked, untracked and binary files", async () => {
    writeFileSync(join(repo, "a.txt"), "one\n2\nthree\n");
    writeFileSync(join(repo, "new.txt"), "hello\nworld\n");
    writeFileSync(join(repo, "img.bin"), Buffer.from([0, 1, 2, 0]));
    const svc = new GitChangesService();
    const tracked = await svc.diff(repo, "a.txt");
    expect(tracked.binary).toBe(false);
    expect(tracked.lines).toEqual([
      { type: "context", text: "one", oldLine: 1, newLine: 1 },
      { type: "del", text: "two", oldLine: 2 },
      { type: "add", text: "2", newLine: 2 },
      { type: "context", text: "three", oldLine: 3, newLine: 3 },
    ]);
    const untracked = await svc.diff(repo, "new.txt");
    expect(untracked.lines).toEqual([
      { type: "add", text: "hello", newLine: 1 },
      { type: "add", text: "world", newLine: 2 },
    ]);
    expect(await svc.diff(repo, "img.bin")).toMatchObject({ binary: true, lines: [] });
  });

  it("rejects paths outside the folder or without changes", async () => {
    const svc = new GitChangesService();
    await expect(svc.diff(repo, "../outside.txt")).rejects.toMatchObject({ status: 400 });
    await expect(svc.diff(repo, "/etc/passwd")).rejects.toMatchObject({ status: 400 });
    await expect(svc.revert(repo, ["sub/../../x"])).rejects.toMatchObject({ status: 400 });
    await expect(svc.revert(repo, ["a.txt"])).rejects.toMatchObject({ status: 404 });
    expect(isSafeRelativePath("src/a.ts")).toBe(true);
    expect(isSafeRelativePath("./a")).toBe(false);
    expect(isSafeRelativePath("a//b")).toBe(false);
  });

  it("reverts modified, deleted, added, renamed and untracked files", async () => {
    writeFileSync(join(repo, "a.txt"), "changed\n");
    unlinkSync(join(repo, "b.txt"));
    git("mv", "c.txt", "d.txt");
    writeFileSync(join(repo, "staged.txt"), "s\n");
    git("add", "staged.txt");
    writeFileSync(join(repo, "new.txt"), "x\n");
    const res = await new GitChangesService().revert(repo, ["a.txt", "b.txt", "d.txt", "staged.txt", "new.txt"]);
    expect(files(res)).toEqual({});
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    expect(existsSync(join(repo, "b.txt"))).toBe(true);
    expect(existsSync(join(repo, "c.txt"))).toBe(true);
    expect(existsSync(join(repo, "d.txt"))).toBe(false);
    expect(existsSync(join(repo, "staged.txt"))).toBe(false);
    expect(existsSync(join(repo, "new.txt"))).toBe(false);
  });

  it("commits selected files, leaving the rest", async () => {
    writeFileSync(join(repo, "a.txt"), "changed\n");
    unlinkSync(join(repo, "b.txt"));
    writeFileSync(join(repo, "new.txt"), "x\n");
    writeFileSync(join(repo, "other.txt"), "y\n");
    const svc = new GitChangesService();
    const res = await svc.commit(repo, "Change things\n\nBody", ["a.txt", "b.txt", "new.txt"]);
    expect(res.summary).toBe("Change things");
    expect(git("rev-parse", "--short", "HEAD").trim()).toBe(res.commit);
    expect(git("log", "-1", "--format=%B").trim()).toBe("Change things\n\nBody");
    expect(Object.keys(files(await svc.status(repo)))).toEqual(["other.txt"]);
  });

  it("commits everything, including renames, and the first commit of a new repo", async () => {
    git("mv", "c.txt", "d.txt");
    writeFileSync(join(repo, "a.txt"), "changed\n");
    const svc = new GitChangesService();
    await svc.commit(repo, "All");
    expect(files(await svc.status(repo))).toEqual({});
    await expect(svc.commit(repo, "Again")).rejects.toMatchObject({ status: 409 });

    const fresh = join(dir, "fresh");
    mkdirSync(fresh);
    execFileSync("git", ["init", "-q"], { cwd: fresh });
    execFileSync("git", ["config", "user.name", "T"], { cwd: fresh });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: fresh });
    writeFileSync(join(fresh, "f.txt"), "f\n");
    expect(files(await svc.status(fresh))["f.txt"]).toMatchObject({ kind: "untracked", added: 1 });
    await svc.commit(fresh, "First");
    expect(files(await svc.status(fresh))).toEqual({});
  });

  it("generates a commit message with the small model", async () => {
    writeFileSync(join(repo, "a.txt"), "changed\n");
    writeFileSync(join(repo, "new.txt"), "brand new\n");
    const complete = vi.fn(async () => "```\nUpdate a.txt and add new.txt\n```");
    const res = await new GitChangesService({ complete }).commitMessage(repo);
    expect(res.message).toBe("Update a.txt and add new.txt");
    const [prompt, cwd] = complete.mock.calls[0] as unknown as [string, string];
    expect(cwd).toBe(repo);
    expect(prompt).toContain("modified a.txt");
    expect(prompt).toContain("-one");
    expect(prompt).toContain("brand new");
    await expect(new GitChangesService().commitMessage(repo)).rejects.toMatchObject({ status: 501 });
  });

  it("handles renamed files in a working-tree rename (delete + untracked)", async () => {
    renameSync(join(repo, "c.txt"), join(repo, "e.txt"));
    const byPath = files(await new GitChangesService().status(repo));
    expect(byPath["c.txt"]?.kind).toBe("deleted");
    expect(byPath["e.txt"]?.kind).toBe("untracked");
  });
});

describe("parsing helpers", () => {
  it("adds gaps between hunks and before a hunk that doesn't start at line 1", () => {
    const diff = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -5,1 +5,1 @@", "-a", "+b", "@@ -20,1 +20,1 @@", " c", "\\ No newline at end of file"].join("\n");
    expect(parseUnifiedDiff(diff).lines.map((l) => l.type)).toEqual(["gap", "del", "add", "gap", "context"]);
  });

  it("cleans model replies", () => {
    expect(cleanCommitMessage('"Fix bug"')).toBe("Fix bug");
    expect(cleanCommitMessage("Commit message: Fix bug")).toBe("Fix bug");
  });
});

describe("changes routes", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = createTestEnv();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("serves status, diff, revert, commit and commit-message for a workspace", async () => {
    const { app } = createApp({ service: env.service });
    const req = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { host: "127.0.0.1:4317", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const project = (await (await req("POST", "/api/projects", { path: repo })).json()) as Project;
    const { wid } = await newChat(env, { projectId: project.id });
    writeFileSync(join(repo, "a.txt"), "changed\n");
    writeFileSync(join(repo, "new.txt"), "x\n");

    const status = (await (await req("GET", `/api/workspaces/${wid}/changes`)).json()) as GitChangesResponse;
    expect(Object.keys(files(status)).sort()).toEqual(["a.txt", "new.txt"]);
    const diff = (await (await req("GET", `/api/workspaces/${wid}/changes/diff?path=new.txt`)).json()) as GitFileDiffResponse;
    expect(diff.lines).toEqual([{ type: "add", text: "x", newLine: 1 }]);
    expect((await req("GET", `/api/workspaces/${wid}/changes/diff?path=..%2Fx`)).status).toBe(400);
    expect((await req("GET", `/api/workspaces/${wid}/changes/diff`)).status).toBe(400);
    expect((await req("POST", `/api/workspaces/${wid}/changes/revert`, { paths: "a.txt" })).status).toBe(400);

    const reverted = (await (await req("POST", `/api/workspaces/${wid}/changes/revert`, { paths: ["new.txt"] })).json()) as GitChangesResponse;
    expect(Object.keys(files(reverted))).toEqual(["a.txt"]);

    vi.spyOn(env.service, "completeQuick").mockResolvedValue("Change a.txt");
    const msg = await req("POST", `/api/workspaces/${wid}/changes/commit-message`);
    expect(await msg.json()).toEqual({ message: "Change a.txt" });

    expect((await req("POST", `/api/workspaces/${wid}/changes/commit`, { message: " " })).status).toBe(400);
    const commit = (await (await req("POST", `/api/workspaces/${wid}/changes/commit`, { message: "Change a.txt" })).json()) as CommitChangesResponse;
    expect(commit.summary).toBe("Change a.txt");
    expect(files((await (await req("GET", `/api/workspaces/${wid}/changes`)).json()) as GitChangesResponse)).toEqual({});

    expect((await req("GET", "/api/workspaces/nope/changes")).status).toBe(404);
  });

  it("reports a standalone chat's scratch folder as not a repository", async () => {
    const { app } = createApp({ service: env.service });
    const { wid } = await newChat(env);
    const res = await app.request(`/api/workspaces/${wid}/changes`, { headers: { host: "127.0.0.1:4317" } });
    expect(await res.json()).toEqual({ isRepo: false });
  });
});
