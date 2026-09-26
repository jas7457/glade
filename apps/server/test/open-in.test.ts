/**
 * I-026: `POST /api/projects/:id/open` with an injected command runner (never launches apps).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { createOpenIn, type CommandRunner, type RunResult } from "../src/services/open-in.js";
import { createTestEnv, type TestEnv } from "./helpers.js";

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

function open(projectId: string, body: unknown) {
  const { app } = createApp({ service: env.service });
  return app.request(`/api/projects/${projectId}/open`, {
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
