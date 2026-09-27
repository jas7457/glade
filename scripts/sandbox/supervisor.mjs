/**
 * Sandbox supervisor (I-052): a detached process started by the first `pnpm dev:agent` owner of
 * a sandbox. It runs the sandbox's server (tsx watch) and web (Vite) on the ports recorded in
 * sandbox.json, seeds sample data once the server answers, then watches the owners list: when no
 * live owner remains it stops both and deletes the sandbox (unless an owner passed `--keep`).
 *
 * Usage (internal): node scripts/sandbox/supervisor.mjs <sandboxDir>
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deleteSandboxSessions,
  isPidAlive,
  killGroup,
  pruneDeadOwners,
  readState,
  withLock,
  writeState,
} from "./lib.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const dir = process.argv[2];
if (!dir) {
  console.error("usage: supervisor.mjs <sandboxDir>");
  process.exit(2);
}
const log = (msg) => console.log(`[supervisor ${new Date().toISOString()}] ${msg}`);

const initial = readState(dir);
if (!initial) {
  log("no sandbox.json, nothing to supervise");
  process.exit(1);
}
const { name, harness, serverPort, webPort } = initial;
const dataDir = join(dir, "data");
const repoDir = join(dir, "repo");
const logsDir = join(dir, "logs");
mkdirSync(dataDir, { recursive: true });
mkdirSync(logsDir, { recursive: true });

/** @param {(s: any) => any} fn */
const update = (fn) =>
  withLock(dir, () => {
    const state = readState(dir);
    if (!state) return null;
    const next = fn(state);
    writeState(dir, next);
    return next;
  });

const childEnv = {
  ...process.env,
  GLADE_DATA_DIR: dataDir,
  GLADE_HOST: "127.0.0.1",
  GLADE_PORT: String(serverPort),
  GLADE_WEB_PORT: String(webPort),
  GLADE_HARNESS: harness === "fake" ? "fake" : "pi",
  GLADE_SERVER_KIND: "sandbox",
  GLADE_SANDBOX: name,
};
// Neither under the new nor the pre-rename (I-059) names: the server reads both.
for (const prefix of ["GLADE_", "PI_UI_"]) {
  delete childEnv[`${prefix}NO_LOCK`];
  delete childEnv[`${prefix}STATIC_DIR`];
}

function start(label, cwd, bin, args) {
  const out = openSync(join(logsDir, `${label}.log`), "a");
  const child = spawn(bin, args, { cwd, env: childEnv, detached: true, stdio: ["ignore", out, out] });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    log(`${label} exited (code ${code}, signal ${signal}); stopping the sandbox`);
    void stop(`${label} exited`);
  });
  return child;
}

let stopping = false;
/** @type {NodeJS.Timeout | undefined} */
let watch;
const server = start("server", join(repoRoot, "apps/server"), join(repoRoot, "apps/server/node_modules/.bin/tsx"), [
  "watch",
  "--clear-screen=false",
  "src/index.ts",
]);
const web = start("web", join(repoRoot, "apps/web"), join(repoRoot, "apps/web/node_modules/.bin/vite"), []);
update((s) => ({ ...s, supervisorPid: process.pid, serverPid: server.pid, webPid: web.pid }));
log(`started server (pid ${server.pid}, :${serverPort}) and web (pid ${web.pid}, :${webPort})`);

const api = `http://127.0.0.1:${serverPort}/api`;
async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stopping) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
async function post(path, body) {
  const res = await fetch(`${api}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${webPort}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

function createSampleRepo() {
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "README.md"), `# sample-repo\n\nA tiny repo seeded by \`pnpm dev:agent\` (sandbox "${name}").\n`);
  writeFileSync(join(repoDir, "src", "greet.js"), `export function greet(name) {\n  return \`Hello, \${name}!\`;\n}\n`);
  const git = (...args) => execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.name=Glade sandbox", "-c", "user.email=sandbox@glade.invalid", "commit", "-q", "-m", "Initial commit");
}

async function seed() {
  createSampleRepo();
  const project = await post("/projects", { path: repoDir, name: "sample-repo" });
  if (harness === "fake") {
    await post("/workspaces", { projectId: project.id, prompt: "Hello from the sandbox" });
    await post("/workspaces", { projectId: project.id, prompt: "What does src/greet.js do?" });
    await post("/workspaces", { projectId: null, prompt: "A standalone chat" });
  } else {
    // Real pi: no prompts (no LLM cost); an empty chat shows the project is wired up.
    await post("/workspaces", { projectId: project.id });
  }
}

/** Stops server + web, then deletes the sandbox unless it's kept. */
async function stop(reason, { keepForOwners = false } = {}) {
  if (stopping) return;
  stopping = true;
  clearInterval(watch);
  log(`stopping: ${reason}`);
  for (const child of [server, web]) killGroup(child.pid, "SIGTERM");
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && [server, web].some((c) => c.exitCode === null && c.signalCode === null)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const child of [server, web]) killGroup(child.pid, "SIGKILL");
  // Wait briefly for the owners to read an error before deleting everything.
  if (keepForOwners) await new Promise((r) => setTimeout(r, 3000));
  withLock(dir, () => {
    const state = readState(dir);
    if (state?.keep) {
      writeState(dir, { ...state, supervisorPid: null, serverPid: null, webPid: null, ready: false });
      log(`kept at ${dir}`);
      return;
    }
    const deleted = deleteSandboxSessions(dir);
    if (deleted.length) log(`deleted ${deleted.length} pi session file(s)`);
    rmSync(dir, { recursive: true, force: true });
  });
  process.exit(0);
}

watch = setInterval(() => {
  if (stopping) return;
  let remaining = 1;
  try {
    const next = update((s) => pruneDeadOwners(s, isPidAlive));
    remaining = next ? next.owners.length : 0;
  } catch (err) {
    log(`watch failed: ${err}`);
  }
  if (remaining === 0) void stop("no owners left");
}, 1000);

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => void stop(sig));

try {
  if (!(await waitFor(`${api}/settings`, 90_000))) throw new Error("server did not start (see logs/server.log)");
  if (!initial.seeded) {
    // A seeding failure (e.g. pi can't start) is reported but doesn't stop the sandbox.
    try {
      await seed();
      log("seeded sample data");
    } catch (err) {
      log(`seeding failed: ${err instanceof Error ? err.message : err}`);
      update((s) => ({ ...s, seedError: String(err instanceof Error ? err.message : err).slice(0, 500) }));
    }
    update((s) => ({ ...s, seeded: true }));
  }
  if (!(await waitFor(`http://127.0.0.1:${webPort}/`, 60_000))) throw new Error("web did not start (see logs/web.log)");
  update((s) => ({ ...s, ready: true }));
  log("ready");
} catch (err) {
  log(`startup failed: ${err instanceof Error ? err.message : err}`);
  update((s) => ({ ...s, error: String(err instanceof Error ? err.message : err) }));
  await stop("startup failed", { keepForOwners: true });
}
