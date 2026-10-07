/**
 * Agent versions (I-198): where each built-in agent's installed and newest versions come from,
 * and how to compare them. Read-only: a `--version` run and one HTTPS GET per agent.
 *
 *   parseVersion("Warning: …\n0.71.2\n")          // "0.71.2" (the last x.y.z)
 *   compareVersions("2.1.280", "2.1.293")         // < 0
 *   await AGENT_VERSION_SOURCES.claude.latest({ fetchText, claudeChannel: () => "latest" })
 *
 * - pi: `pi --version`; latest from npm (`@earendil-works/pi-coding-agent`).
 * - Claude Code: `claude --version` ("2.1.280 (Claude Code)"); latest from Claude Code's release
 *   channel (`downloads.claude.ai/claude-code-releases/<latest|stable>`, plain text), the channel
 *   the user's `claude` follows (`autoUpdatesChannel` in `~/.claude/settings.json`, default latest).
 * - Codex: `codex --version` ("codex-cli 0.159.1"); latest from npm (`@openai/codex`).
 *
 * The installed version is read from the agent's executable as the harnesses find it (the
 * server's PATH, which the Mac app sets from the user's login shell), with stdin closed, Glade's own
 * config stripped from the environment (`updateEnv`) and a timeout.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findExecutable } from "../../harness/which.js";
import { runInLoginShell, updateEnv } from "../update-job.js";

const VERSION_RE = /\b(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/g;
const VERSION_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 15_000;

/** The last `x.y.z` (with an optional prerelease) in `text`, or null. */
export function parseVersion(text: string): string | null {
  let last: string | null = null;
  for (const m of text.matchAll(VERSION_RE)) last = m[0];
  return last;
}

/** Numeric major.minor.patch comparison (prerelease/build parts ignored): < 0, 0, > 0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v.trim())?.slice(1) ?? ["0", "0", "0"]).map(Number);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  return 0;
}

/** GET `url` as text; throws (with the HTTP status) on failure. Injectable in tests. */
export type FetchText = (url: string) => Promise<string>;

export const fetchText: FetchText = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json, text/plain" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

export interface LatestContext {
  fetchText: FetchText;
  /** Claude Code's release channel. */
  claudeChannel: () => "latest" | "stable";
}

export interface LatestVersion {
  version: string;
  /** For display: "npm", "Claude Code latest channel". */
  source: string;
}

export interface AgentVersionSource {
  /** The executable (`pi`, `claude`, `codex`). */
  command: string;
  latest(ctx: LatestContext): Promise<LatestVersion>;
}

/** Where a failed request was going, for the reason sentence. */
class SourceError extends Error {}

async function npmLatest(pkg: string, ctx: LatestContext): Promise<LatestVersion> {
  let body: string;
  try {
    body = await ctx.fetchText(`https://registry.npmjs.org/${pkg}/latest`);
  } catch (err) {
    throw new SourceError(`Couldn't reach npm (${errorText(err)}).`);
  }
  let version: unknown;
  try {
    version = (JSON.parse(body) as { version?: unknown }).version;
  } catch {
    version = undefined;
  }
  if (typeof version !== "string" || !parseVersion(version)) throw new SourceError(`npm gave an unexpected answer for ${pkg}.`);
  return { version, source: "npm" };
}

export const AGENT_VERSION_SOURCES: Readonly<Record<string, AgentVersionSource>> = Object.freeze({
  pi: { command: "pi", latest: (ctx: LatestContext) => npmLatest("@earendil-works/pi-coding-agent", ctx) },
  claude: {
    command: "claude",
    async latest(ctx: LatestContext): Promise<LatestVersion> {
      const channel = ctx.claudeChannel();
      let body: string;
      try {
        body = await ctx.fetchText(`https://downloads.claude.ai/claude-code-releases/${channel}`);
      } catch (err) {
        throw new SourceError(`Couldn't reach Claude Code's release server (${errorText(err)}).`);
      }
      const version = body.trim();
      if (!/^\d+\.\d+\.\d+/.test(version) || version.length > 64) throw new SourceError("Claude Code's release server gave an unexpected answer.");
      return { version, source: `Claude Code ${channel} channel` };
    },
  },
  codex: { command: "codex", latest: (ctx: LatestContext) => npmLatest("@openai/codex", ctx) },
});

/**
 * The release channel the user's Claude Code follows: `autoUpdatesChannel` in
 * `~/.claude/settings.json` ("stable" or "latest"), read-only; "latest" when unset or unreadable.
 */
export function readClaudeChannel(file = join(homedir(), ".claude", "settings.json")): "latest" | "stable" {
  try {
    const settings = JSON.parse(readFileSync(file, "utf8")) as { autoUpdatesChannel?: unknown };
    return settings.autoUpdatesChannel === "stable" ? "stable" : "latest";
  } catch {
    return "latest";
  }
}

/** What reading the installed version found. */
export type InstalledVersion = { installed: false } | { installed: true; version: string | null; output: string };

/** Reads an agent's installed version (injectable in tests). */
export type ReadInstalled = (harness: string) => Promise<InstalledVersion>;

/** `<path> --version` with stdin closed: stdout and stderr, or throws on timeout/spawn errors. */
export function runVersionCommand(path: string, args: string[] = ["--version"], timeoutMs = VERSION_TIMEOUT_MS): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, args, { env: updateEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`\`${[path, ...args].join(" ")}\` took longer than ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")).length > 65_536 && (stdout = stdout.slice(-65_536)));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")).length > 65_536 && (stderr = stderr.slice(-65_536)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * The default {@link ReadInstalled}: finds the agent's executable on the PATH and runs
 * `--version`. `overrides[harness]` (testing only, e.g. `GLADE_AGENT_VERSION_COMMAND_CLAUDE`) is a
 * shell command run through the login shell instead, whose output holds the version.
 */
export function defaultReadInstalled(overrides: Readonly<Record<string, string>> = {}): ReadInstalled {
  return async (harness) => {
    const override = overrides[harness];
    if (override) {
      let output = "";
      const code = await runInLoginShell(override, homedir(), (chunk) => (output += chunk), new AbortController().signal);
      if (code !== 0 && !output.trim()) return { installed: false };
      return { installed: true, version: parseVersion(output), output };
    }
    const source = AGENT_VERSION_SOURCES[harness];
    const path = source ? findExecutable(source.command) : null;
    if (!path) return { installed: false };
    const { stdout, stderr } = await runVersionCommand(path);
    // pi may print warnings first: the version is the last x.y.z on stdout (else stderr).
    return { installed: true, version: parseVersion(stdout) ?? parseVersion(stderr), output: (stdout + stderr).trim() };
  };
}

export function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\.$/, "") || "unknown error";
}

export { SourceError };

/**
 * Testing overrides from the environment, per agent (never set in normal use): `GLADE_AGENT_UPDATE_COMMAND_<ID>`
 * replaces the updater (e.g. `GLADE_AGENT_UPDATE_COMMAND_CLAUDE='echo 2.1.293 > /tmp/v'` in a
 * sandbox), `GLADE_AGENT_VERSION_COMMAND_<ID>` the installed-version reading (`cat /tmp/v`), both
 * run through the login shell. `<ID>` is the harness id in upper case (PI, CLAUDE, CODEX).
 */
export function testingOverrides(kind: "UPDATE" | "VERSION", harnesses: readonly string[], source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of harnesses) {
    const value = source[`GLADE_AGENT_${kind}_COMMAND_${h.toUpperCase()}`]?.trim();
    if (value) out[h] = value;
  }
  return out;
}
