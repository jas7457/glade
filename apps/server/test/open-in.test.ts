/**
 * I-026: `POST /api/projects/:id/open`, I-106: `POST /api/workspaces/:id/open` (the chat's own
 * folder, e.g. its worktree), both with an injected command runner (never launches apps).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { createOpenIn, type CommandRunner, type RunResult } from "../src/services/open-in.js";
import { createTestEnv, flush, newChat, type TestEnv } from "./helpers.js";

let env: TestEnv;
let calls: Array<[string, string[]]>;
let result: RunResult;
let platform: NodeJS.Platform;

const run: CommandRunner = async (file, args) => {
  calls.push([file, args]);
  return result;
};

beforeEach(() => {
  calls = [];
  result = { exitCode: 0, stderr: "" };
  platform = "darwin";
  env = createTestEnv({ openIn: (target, path) => createOpenIn({ platform, run })(target, path) });
});
afterEach(async () => {
  await env.cleanup();
});

function open(projectId: string, body: unknown, kind: "projects" | "workspaces" = "projects") {
  const { app } = createApp({ service: env.service });
  return app.request(`/api/${kind}/${projectId}/open`, {
    method: "POST",
    headers: { host: "127.0.0.1:4317", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function project() {
  const path = join(env.dir, "proj");
  mkdirSync(path, { recursive: true });
  return env.service.createProject({ path });
}

describe("open project in app", () => {
  it("opens the project folder in VS Code", async () => {
    const p = project();
    expect((await open(p.id, { app: "vscode" })).status).toBe(204);
    expect(calls).toEqual([["open", ["-a", "Visual Studio Code", p.path]]]);
  });

  it("404 for unknown projects, 400 for unknown apps", async () => {
    const p = project();
    expect((await open("missing", { app: "vscode" })).status).toBe(404);
    expect((await open(p.id, { app: "emacs" })).status).toBe(400);
    expect((await open(p.id, { app: "toString" })).status).toBe(400);
    expect((await open(p.id, {})).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("424 with a clear message when the app isn't installed", async () => {
    const p = project();
    result = { exitCode: 1, stderr: "Unable to find application named 'Visual Studio Code'\n" };
    const res = await open(p.id, { app: "vscode" });
    expect(res.status).toBe(424);
    expect(await res.json()).toEqual({ error: "Visual Studio Code isn't installed" });
  });

  it("500 on other failures, 501 off macOS", async () => {
    const p = project();
    result = { exitCode: 1, stderr: "something else" };
    expect((await open(p.id, { app: "vscode" })).status).toBe(500);
    platform = "linux";
    const res = await open(p.id, { app: "vscode" });
    expect(res.status).toBe(501);
    expect(calls).toHaveLength(1);
  });
});

describe("open workspace in app (I-106)", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

  function repoProject() {
    const path = join(env.dir, "repo");
    mkdirSync(path, { recursive: true });
    git(path, "init", "-q", "-b", "main");
    git(path, "config", "user.email", "t@example.com");
    git(path, "config", "user.name", "Test");
    git(path, "config", "commit.gpgsign", "false");
    writeFileSync(join(path, "a.txt"), "a\n");
    git(path, "add", ".");
    git(path, "commit", "-q", "-m", "init");
    return env.service.createProject({ path: realpathSync(path) });
  }

  it("opens a local chat's folder (the project folder)", async () => {
    const p = project();
    const chat = await newChat(env, { projectId: p.id, prompt: "hi" });
    await flush();
    expect((await open(chat.wid, { app: "vscode" }, "workspaces")).status).toBe(204);
    expect(calls).toEqual([["open", ["-a", "Visual Studio Code", p.path]]]);
  });

  it("opens a worktree chat's worktree, not the project folder", async () => {
    const p = repoProject();
    const chat = await newChat(env, { projectId: p.id, prompt: "fix login", worktree: true });
    await flush();
    const cwd = env.store.getWorkspace(chat.wid)!.cwd;
    expect(cwd).not.toBe(p.path);
    expect((await open(chat.wid, { app: "vscode" }, "workspaces")).status).toBe(204);
    expect(calls).toEqual([["open", ["-a", "Visual Studio Code", cwd]]]);
  });

  it("404 for unknown workspaces, 400 for unknown apps", async () => {
    const chat = await newChat(env, { projectId: project().id, prompt: "hi" });
    await flush();
    expect((await open("missing", { app: "vscode" }, "workspaces")).status).toBe(404);
    expect((await open(chat.wid, { app: "emacs" }, "workspaces")).status).toBe(400);
    expect(calls).toEqual([]);
  });
});
