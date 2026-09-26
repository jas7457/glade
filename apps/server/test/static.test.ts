import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { createTestEnv, type TestEnv } from "./helpers.js";

const headers = { host: "127.0.0.1:4317" };

describe("static web app", () => {
  let env: TestEnv;
  let staticDir: string;
  beforeEach(() => {
    env = createTestEnv();
    staticDir = join(env.dir, "web-dist");
  });
  afterEach(() => env.cleanup());

  it("starts serving the web app once it's built, without a restart", async () => {
    const { app } = createApp({ service: env.service, staticDir });
    expect((await app.request("/", { headers })).status).toBe(404);

    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>pi-ui</title>");
    const res = await app.request("/projects/abc", { headers });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>pi-ui</title>");
    // API paths never fall back to the SPA.
    expect((await app.request("/api/nope", { headers })).status).toBe(404);

    rmSync(staticDir, { recursive: true, force: true });
    expect((await app.request("/", { headers })).status).toBe(404);
  });
});
