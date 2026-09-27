#!/usr/bin/env node
/**
 * `pnpm dev:agent` (I-052): a throwaway Glade (server + web) for agents, isolated from the
 * user's data folder and their servers on :4317/:5317, and deleted when the agent is done.
 *
 *   pnpm dev:agent [--name <name>] [--real] [--keep]   start or join sandbox <name> (default "agent")
 *   pnpm dev:agent --name <name> --stop                stop sandbox <name> for every owner
 *   pnpm dev:agent --sweep                             remove every sandbox nobody uses any more
 *
 * One sandbox per name under /tmp/glade-sandbox/<name>, shared by every process started with
 * that name (ref-counted owners in sandbox.json). This process is one owner: it stays in the
 * foreground until Ctrl-C / SIGTERM, then leaves; the last owner out triggers the cleanup
 * (done by the sandbox's supervisor, see scripts/sandbox/supervisor.mjs and lib.mjs).
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addOwner,
  DEFAULT_ROOT,
  destroySandbox,
  isPidAlive,
  parseArgs,
  pickPorts,
  probeFreePort,
  readState,
  removeOwner,
  sandboxDir,
  sandboxPorts,
  startDecision,
  sweep,
  sweepLegacy,
  withLock,
  writeState,
} from "./sandbox/lib.mjs";

const HELP = `pnpm dev:agent [--name <name>] [--real] [--keep]
  Start (or join) the sandbox <name>: its own data folder under ${DEFAULT_ROOT}/<name>, its own
  free ports, sample data, fake harness. Stays in the foreground; Ctrl-C (or SIGTERM) leaves it.
  The sandbox and the pi session files its chats created are deleted when its last user leaves.

  --name <name>  sandbox to start or join (default "agent"); same name = shared sandbox
  --real         use the real pi harness instead of the fake one (costs tokens: keep prompts tiny)
  --keep         don't delete the sandbox when the last user leaves; the next start with the same
                 name resumes it (else the sweep removes it after 24h)
  --stop         stop sandbox <name> now, for everyone using it
  --sweep        remove every sandbox without a live user, whatever its age
`;

const say = (msg) => console.log(`[dev:agent] ${msg}`);

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`[dev:agent] ${err.message}\n\n${HELP}`);
  process.exit(2);
}
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const swept = [...sweep({ skip: args.name, force: args.sweep }), ...sweepLegacy({ force: args.sweep })];
if (swept.length) say(`removed stale sandbox(es): ${swept.join(", ")}`);
if (args.sweep) {
  if (!swept.length) say("nothing to sweep");
  process.exit(0);
}

const dir = sandboxDir(args.name);

if (args.stop) {
  const state = readState(dir);
  if (!state) {
    say(`no sandbox named ${args.name}`);
    process.exit(0);
  }
  for (const owner of state.owners) if (isPidAlive(owner.pid)) process.kill(owner.pid, "SIGTERM");
  if (state.supervisorPid && isPidAlive(state.supervisorPid)) process.kill(state.supervisorPid, "SIGTERM");
  await waitUntil(() => !existsSync(dir) || !isPidAlive(state.supervisorPid ?? 0), 15_000);
  say(existsSync(dir) ? `stopped ${args.name} (kept at ${dir})` : `stopped and removed ${args.name}`);
  process.exit(0);
}

// Join or create --------------------------------------------------------------------------------
const harness = args.real ? "pi" : "fake";
const [serverPort, webPort] = await pickPorts(2, probeFreePort, sandboxPorts());
let joined;
try {
  joined = withLock(dir, () => {
    const state = readState(dir);
    const decision = startDecision(state, isPidAlive);
    if (decision === "join") {
      if (state.harness !== harness) {
        throw new Error(`sandbox "${args.name}" runs the ${state.harness} harness; use another --name`);
      }
      let next = addOwner(state, process.pid, Date.now());
      if (args.keep) next = { ...next, keep: true };
      writeState(dir, next);
      return true;
    }
    // A sandbox left by --keep is resumed (same data, new ports); crash leftovers start fresh.
    const resume = decision === "reclaim" && state.keep && state.harness === harness && state.seeded;
    if (decision === "reclaim" && !resume) destroySandbox(dir);
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeState(dir, {
      name: args.name,
      harness,
      serverPort,
      webPort,
      keep: args.keep,
      createdAt: Date.now(),
      owners: [{ pid: process.pid, since: Date.now() }],
      supervisorPid: null,
      serverPid: null,
      webPid: null,
      seeded: resume,
      ready: false,
    });
    const out = openSync(join(dir, "logs", "supervisor.log"), "a");
    const supervisor = spawn(process.execPath, [fileURLToPath(new URL("./sandbox/supervisor.mjs", import.meta.url)), dir], {
      detached: true,
      stdio: ["ignore", out, out],
    });
    supervisor.unref();
    writeState(dir, { ...readState(dir), supervisorPid: supervisor.pid });
    return false;
  });
} catch (err) {
  console.error(`[dev:agent] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

// Leave on exit ----------------------------------------------------------------------------------
let left = false;
function leave() {
  if (left) return;
  left = true;
  try {
    withLock(dir, () => {
      const state = readState(dir);
      if (state) writeState(dir, removeOwner(state, process.pid));
    });
  } catch {}
}
process.on("exit", leave);
async function quit(reason, code = 0) {
  leave();
  const state = readState(dir);
  const last = state && !state.owners.some((o) => isPidAlive(o.pid));
  if (last && !state.keep) {
    say(`${reason}: last user left, cleaning up ${dir}…`);
    await waitUntil(() => !existsSync(dir), 15_000);
    say(existsSync(dir) ? `cleanup still running (supervisor pid ${state.supervisorPid})` : "sandbox removed");
  } else if (last) {
    say(`${reason}: sandbox kept at ${dir}`);
  } else {
    say(`${reason}: left sandbox ${args.name} (still used by others)`);
  }
  process.exit(code);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => void quit(sig));

// Wait until ready -------------------------------------------------------------------------------
say(`${joined ? "joining" : "starting"} sandbox ${args.name} (${dir})…`);
const readyState = await waitUntil(() => {
  const s = readState(dir);
  return !s || s.ready || s.error ? s ?? { error: "sandbox disappeared" } : null;
}, 180_000);
if (!readyState || readyState.error) {
  console.error(`[dev:agent] sandbox failed: ${readyState?.error ?? "timed out"}`);
  for (const f of ["supervisor", "server", "web"]) printTail(join(dir, "logs", `${f}.log`));
  await quit("failed", 1);
}

const s = readyState;
console.log(`
┌─ Glade sandbox "${args.name}" ${joined ? "(joined)" : ""}
│  Web:      http://127.0.0.1:${s.webPort}
│  API:      http://127.0.0.1:${s.serverPort}/api
│  Harness:  ${s.harness}
│  Data:     ${join(dir, "data")}
│  Repo:     ${join(dir, "repo")}  (project "sample-repo")
│  Logs:     ${join(dir, "logs")}
│  Owner:    pid ${process.pid} (${readState(dir)?.owners.length ?? 1} user(s))
└─ Stop: Ctrl-C, kill ${process.pid}, or pnpm dev:agent --name ${args.name} --stop
`);
if (s.seedError) console.warn(`[dev:agent] warning: sample data incomplete: ${s.seedError}`);

// Stay in the foreground; exit if the sandbox goes away, our parent dies, or one of the pnpm
// wrappers above us is killed (`kill <pnpm pid>` doesn't reach us; pnpm-native lingers).
const parent = process.ppid;
const wrappers = pnpmAncestors();
setInterval(() => {
  const state = readState(dir);
  if (!state || !state.supervisorPid || !isPidAlive(state.supervisorPid)) void quit("sandbox stopped");
  else if (process.ppid !== parent || wrappers.some((pid) => !isPidAlive(pid))) void quit("parent exited");
}, 1000);

// Helpers ----------------------------------------------------------------------------------------
async function waitUntil(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Pids of the consecutive `pnpm` processes directly above us (none when run with plain node). */
function pnpmAncestors() {
  const pids = [];
  let pid = process.ppid;
  try {
    for (let i = 0; i < 5 && pid > 1; i++) {
      const [ppid, ...cmd] = execFileSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8" })
        .trim()
        .split(/\s+/);
      if (!/pnpm/.test(cmd.slice(0, 2).join(" "))) break;
      pids.push(pid);
      pid = Number(ppid);
    }
  } catch {}
  return pids;
}

function printTail(file) {
  try {
    const lines = readFileSync(file, "utf8").trimEnd().split("\n").slice(-15);
    console.error(`--- ${file}\n${lines.join("\n")}`);
  } catch {}
}
