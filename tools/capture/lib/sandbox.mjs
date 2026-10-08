/**
 * Starts the website demo sandbox for the captures (I-209): `pnpm dev:agent --name <name> --demo`
 * (scripts/dev-agent.mjs), waits until it's seeded and ready, and returns its URLs and seed info.
 * `stop()` leaves it, which deletes it (it never touches the user's servers or data folder).
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ROOT = process.env.GLADE_SANDBOX_ROOT || "/tmp/glade-sandbox";

export async function startDemoSandbox({ name = "capture", log = console.log } = {}) {
  const dir = join(ROOT, name);
  // A frozen app: the web app built once and served by the sandbox's own server, which doesn't
  // restart on code changes (other people may be editing while a capture runs).
  const staticDir = join(tmpdir(), `glade-capture-web-${process.pid}`);
  log("building the web app…");
  execFileSync("pnpm", ["--filter", "@glade/web", "exec", "vite", "build", "--outDir", staticDir, "--emptyOutDir", "--logLevel", "error"], { cwd: REPO_ROOT, stdio: "inherit" });
  const env = { ...process.env, GLADE_SANDBOX_STATIC_DIR: staticDir, GLADE_SANDBOX_WATCH: "0" };
  const child = spawn(process.execPath, [join(REPO_ROOT, "scripts/dev-agent.mjs"), "--name", name, "--demo"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const deadline = Date.now() + 240_000;
  for (;;) {
    const state = readState(dir);
    if (state?.ready) break;
    if (state?.error || child.exitCode !== null) throw new Error(`demo sandbox failed: ${state?.error ?? output}`);
    if (Date.now() > deadline) throw new Error(`demo sandbox didn't get ready in time:\n${output}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  const state = readState(dir);
  if (state.seedError) throw new Error(`demo seeding failed: ${state.seedError}`);
  log(`demo sandbox ready: http://127.0.0.1:${state.serverPort}`);
  return {
    dir,
    // The server serves the built app (same origin as the API, like the Mac app).
    web: `http://127.0.0.1:${state.serverPort}`,
    api: `http://127.0.0.1:${state.serverPort}/api`,
    demo: state.demo,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      const until = Date.now() + 20_000;
      while (existsSync(dir) && Date.now() < until) await new Promise((r) => setTimeout(r, 300));
      rmSync(staticDir, { recursive: true, force: true });
    },
  };
}

function readState(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "sandbox.json"), "utf8"));
  } catch {
    return null;
  }
}

/** JSON API call on the sandbox (mutating calls need a loopback Origin: the web's). */
export function apiClient(sandbox) {
  return async (method, path, body) => {
    const res = await fetch(`${sandbox.api}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: sandbox.web },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
}
