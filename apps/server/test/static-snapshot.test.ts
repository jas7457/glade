// I-082: the desktop server serves the web app from a copy taken at startup, so replacing the app
// bundle on disk while it runs doesn't mix new web code with the old server.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { createTestEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
let web: string;
const HOST = { host: "127.0.0.1:4317" };

beforeEach(() => {
  env = createTestEnv();
  web = join(env.dir, "web");
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(join(web, "index.html"), "<html>v1</html>");
  writeFileSync(join(web, "assets", "app.js"), "console.log('v1')");
});
afterEach(async () => {
  await env.cleanup();
});

const get = (app: ReturnType<typeof createApp>["app"], path: string) => app.request(path, { headers: HOST });

describe("static snapshot", () => {
  it("keeps serving the files it started with after the folder changes", async () => {
    const { app } = createApp({ service: env.service, staticDir: web, snapshotStatic: true });
    rmSync(web, { recursive: true, force: true });
    mkdirSync(join(web, "assets"), { recursive: true });
    writeFileSync(join(web, "index.html"), "<html>v2</html>");
    writeFileSync(join(web, "assets", "other.js"), "console.log('v2')");

    const js = await get(app, "/assets/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toBe("console.log('v1')");
    expect(await (await get(app, "/")).text()).toBe("<html>v1</html>");
    // Client routes fall back to index.html; unknown assets are 404s; the API is untouched.
    expect(await (await get(app, "/projects/x/chats/y")).text()).toBe("<html>v1</html>");
    expect((await get(app, "/assets/other.js")).status).toBe(404);
    expect((await get(app, "/api/projects")).status).toBe(200);
  });

  it("without the snapshot, reads the folder per request (dev)", async () => {
    const { app } = createApp({ service: env.service, staticDir: web });
    writeFileSync(join(web, "index.html"), "<html>v2</html>");
    expect(await (await get(app, "/")).text()).toBe("<html>v2</html>");
  });
});
