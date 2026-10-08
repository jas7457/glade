/**
 * Seeds the website demo sandbox (I-209, `pnpm dev:agent --demo`): the Lantern repo with a short
 * git history, the "Studio" environment, settings, a loaded local model, a paired "MacBook Air",
 * and the chats (played by the demo harnesses, apps/server/src/harness/demo/), each run to the
 * end before the next starts so the result is the same every time. Edits the chats make in the
 * project folder are committed like a developer would; the worktree chat's stay uncommitted.
 *
 * Also writes the terminal's shell profile (a clean prompt, no user dotfiles) and the fake
 * Tailscale state. Used by supervisor.mjs; `seedDemo` resolves when everything is idle.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES = fileURLToPath(new URL("./repos/", import.meta.url));
const AUTHOR = ["-c", "user.name=Lantern Maintainers", "-c", "user.email=maintainers@lantern.invalid"];

/** Prompts of the seeded chats (the demo harnesses' scenarios match on them). */
export const DEMO_PROMPTS = {
  retries:
    "Checks against slow endpoints keep flapping between up and down, and every flap pings Slack. Can you add retries with exponential backoff before a check counts as down? Make it configurable per check.",
  audit:
    "Before we tag 1.0, can you get a few agents to review the codebase in parallel? One on the notifiers' error handling, one on the scheduler's timer logic, one on the dashboard's accessibility.",
  auditFix: "Yes, fix 1 and 2.",
  chart: "The uptime chart flickers every time a new data point arrives. Can you figure out why and fix it?",
  region: "We're about to run Lantern from two regions. Record which region ran each check result, and keep old databases working.",
  releaseNotes: "Write the release notes for 0.9.0 from the git log.",
  discord: "Add a Discord notifier alongside Slack and the generic webhook.",
  percentiles: "Should I alert on p95 or p99 latency for Lantern's checks? We check most endpoints every 30 seconds.",
  abort: "AbortSignal.timeout vs an AbortController with setTimeout: which should Lantern use for its fetches?",
  /** Live (captures): the hero's follow-up in the retries chat, and the sub-agents review. */
  jitter: "Nice. Now add jitter so checks that fail together don't retry in lockstep, and get the README and tests updated in parallel.",
  /** Said in the iPhone's conversation mode (iphone-voice). */
  voice: "What's left before we tag 1.0?",
  overlap: "Now fix #3 too: a slow check shouldn't overlap its next run.",
  /** The website's hero-story: a question asked in a new chat. */
  prune: "Every hour the checks stall for about half a second while old results are pruned. Can you find out why and fix it?",
  review: "We're about to ship 1.0. Have three agents look at it in parallel: one checks the API for missing input validation, one profiles the SQLite queries, one writes the missing tests for server.ts.",
};

/** The repo's history before the chats (dates fixed so hashes and ages are stable). */
const HISTORY = [
  { date: "2026-09-14T10:12:00Z", message: "Initial scaffold: HTTP checks and the scheduler", files: ["package.json", "tsconfig.json", ".gitignore", "README.md", "src/config.ts", "src/checks/http.ts", "src/checks/scheduler.ts", "src/cli.ts", "test/http.test.ts", "test/scheduler.test.ts"] },
  { date: "2026-09-18T16:40:00Z", message: "Store results in SQLite, keep 30 days", files: ["src/store.ts", "src/server.ts"] },
  { date: "2026-09-23T09:05:00Z", message: "Add Slack and webhook notifiers", files: ["src/notify", "lantern.config.example.json"] },
  { date: "2026-09-29T14:22:00Z", message: "Dashboard: uptime chart and status badges", files: ["web"] },
];

/** Creates `<root>/lantern` from the template with its git history; returns its path. */
export function createDemoRepo(root) {
  const repo = join(root, "lantern");
  mkdirSync(repo, { recursive: true });
  cpSync(join(TEMPLATES, "lantern"), repo, { recursive: true });
  const git = (args, env = {}) => execFileSync("git", args, { cwd: repo, stdio: "ignore", env: { ...process.env, ...env } });
  git(["init", "-q", "-b", "main"]);
  for (const { date, message, files } of HISTORY) {
    git(["add", "--", ...files]);
    git([...AUTHOR, "commit", "-q", "-m", message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  }
  return repo;
}

/** Commits everything in `repo` (the edits a chat made). */
function commit(repo, message) {
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", [...AUTHOR, "commit", "-q", "-m", message], { cwd: repo, stdio: "ignore" });
}

/**
 * The terminal tab's shell (zsh with `ZDOTDIR` here): a clean prompt, and `pnpm test` answering
 * like the real suite (the demo repo has no node_modules).
 */
export function writeShellProfile(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".zshenv"), "export LANG=en_US.UTF-8\nexport CLICOLOR=1\n");
  writeFileSync(
    join(dir, ".zshrc"),
    `setopt PROMPT_SUBST
unsetopt BEEP
_branch() { local b; b=$(git branch --show-current 2>/dev/null) && [[ -n $b ]] && print -n " %F{blue}git:(%F{red}$b%F{blue})%f"; }
PROMPT='%F{green}➜%f  %F{cyan}%1~%f$(_branch) '
RPROMPT=''
alias ls='ls -G'
pnpm() {
  if [[ "$1" == test ]]; then
    print -P "\\n%F{8}> lantern@0.9.0 test\\n> vitest run%f\\n"
    print -P " %K{cyan}%F{black} RUN %f%k %F{cyan}v3.1.2%f\\n"
    sleep 0.4
    print -P " %F{green}✓%f test/backoff.test.ts %F{8}(5 tests) 4ms%f"
    sleep 0.15
    print -P " %F{green}✓%f test/http.test.ts %F{8}(5 tests) 13ms%f"
    sleep 0.1
    print -P " %F{green}✓%f test/scheduler.test.ts %F{8}(1 test) 9ms%f\\n"
    print -P " %F{8}Test Files%f  %F{green}3 passed%f %F{8}(3)%f"
    print -P "      %F{8}Tests%f  %F{green}11 passed%f %F{8}(11)%f"
    print -P "   %F{8}Start at%f  15:24:09"
    print -P "   %F{8}Duration%f  431ms %F{8}(transform 92ms, setup 0ms, collect 140ms, tests 26ms)%f\\n"
  else
    command pnpm "$@"
  fi
}
`,
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Seeds the sandbox through its API. `api` = `http://127.0.0.1:<port>/api`, `origin` = the web's
 * origin (mutating requests need a loopback Origin), `codeDir` = where repos go, `localModelUrl`
 * = the fake llama-server.
 */
export async function seedDemo({ api, origin, codeDir, localModelUrl, log = () => {} }) {
  const call = async (method, path, body) => {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: { "content-type": "application/json", origin },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };

  const repo = createDemoRepo(codeDir);
  await call("PATCH", "/environment", { name: "Studio" });
  await call("PATCH", "/settings", {
    localModels: { url: localModelUrl },
    agent: { defaultHarness: "pi" },
    general: { generateTitles: true },
  });
  const project = await call("POST", "/projects", { path: repo, name: "lantern" });

  /** Waits until a workspace's runs (and its sub-agents) are done. */
  const idle = async (workspaceId, timeoutMs = 90_000) => {
    const deadline = Date.now() + timeoutMs;
    await sleep(300);
    for (;;) {
      const detail = await call("GET", `/workspaces/${workspaceId}`);
      const busy = detail.sessions.some((s) => s.status === "working" || s.status === "blocked" || s.running);
      const agents = detail.sessions.filter((s) => s.kind === "subagent");
      if (!busy && agents.length === 0) return detail;
      if (Date.now() > deadline) throw new Error(`workspace ${workspaceId} still busy after ${timeoutMs / 1000}s`);
      await sleep(250);
    }
  };
  const chat = async (projectId, prompt, opts = {}) => {
    const created = await call("POST", "/workspaces", { projectId, prompt, ...opts });
    const detail = await idle(created.workspace.id);
    log(`seeded chat "${prompt.slice(0, 50)}…"`);
    return { workspaceId: created.workspace.id, sessionId: created.session.session.id, detail };
  };
  const send = async (workspaceId, sessionId, text) => {
    await call("POST", `/sessions/${sessionId}/prompt`, { text });
    return idle(workspaceId);
  };
  /** Bookmarks the last assistant reply of a session. */
  const bookmarkLast = async (sessionId, label) => {
    const detail = await call("GET", `/sessions/${sessionId}`);
    const messages = detail.transcript.messages.filter((m) => m.role === "assistant" && m.content.some((b) => b.type === "text"));
    const last = messages.at(-1);
    if (!last) return;
    const text = last.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n");
    await call("POST", "/bookmarks", { sessionId, message: { role: "assistant", timestamp: last.timestamp }, text, label });
  };

  const opus = { harness: "pi", model: { provider: "anthropic", id: "claude-opus-5-5" }, thinkingLevel: "high" };
  const created = {};
  // Oldest first; reordered at the end so the hero chat sits on top.
  created.retries = await chat(project.id, DEMO_PROMPTS.retries, opus);
  commit(repo, "Retry flaky checks with exponential backoff");
  await bookmarkLast(created.retries.sessionId, "Retry policy and its trade-off");

  created.audit = await chat(project.id, DEMO_PROMPTS.audit, opus);
  await bookmarkLast(created.audit.sessionId, "Pre-1.0 findings, ranked");
  await send(created.audit.workspaceId, created.audit.sessionId, DEMO_PROMPTS.auditFix);
  await bookmarkLast(created.audit.sessionId, "Notifier fixes");
  commit(repo, "Isolate notifiers and time out their requests");

  created.chart = await chat(project.id, DEMO_PROMPTS.chart, { harness: "claude", model: { provider: "anthropic", id: "sonnet" }, thinkingLevel: "medium", permissionMode: "acceptEdits" });
  commit(repo, "Fix uptime chart flicker");

  created.region = await chat(project.id, DEMO_PROMPTS.region, { harness: "codex", model: { provider: "codex", id: "gpt-6-sol" }, thinkingLevel: "medium", permissionMode: "auto" });
  commit(repo, "Record the region of each result");

  // Local models: load the Qwen model, then a chat on it.
  try {
    await call("POST", "/local-models/load", { model: "Qwen3.8-14B-Q5_K_M" });
  } catch (err) {
    log(`local model load failed: ${err.message}`);
  }
  created.releaseNotes = await chat(project.id, DEMO_PROMPTS.releaseNotes, { harness: "pi", model: { provider: "llama.cpp", id: "Qwen3.8-14B-Q5_K_M" }, thinkingLevel: "off" });

  created.discord = await chat(project.id, DEMO_PROMPTS.discord, { harness: "pi", model: { provider: "anthropic", id: "claude-sonnet-5-5" }, thinkingLevel: "medium", worktree: true, branch: "discord-notifier" });

  created.abort = await chat(null, DEMO_PROMPTS.abort, { harness: "codex", model: { provider: "codex", id: "gpt-6-sol-mini" }, thinkingLevel: "low" });
  created.percentiles = await chat(null, DEMO_PROMPTS.percentiles, { harness: "claude", model: { provider: "anthropic", id: "opus" }, thinkingLevel: "high" });

  // Sidebar order (top first): the hero's chat, then the rest.
  const order = ["retries", "discord", "audit", "chart", "region", "releaseNotes"].map((k) => created[k].workspaceId);
  await call("PUT", "/workspaces/order", { projectId: project.id, folderId: null, ids: order });
  // Everything has been "read".
  for (const { workspaceId } of Object.values(created)) {
    const detail = await call("GET", `/workspaces/${workspaceId}`);
    for (const s of detail.sessions) if (s.unread) await call("PATCH", `/sessions/${s.id}`, { unread: false });
  }

  // Remote access: sharing on, and a MacBook Air paired (the iPhone pairs for real in the captures).
  await call("PATCH", "/auth/remote", { enabled: true });
  let deviceToken = null;
  try {
    deviceToken = await pairDevice(call, api, "MacBook Air", "mac");
  } catch (err) {
    log(`pairing the demo MacBook Air failed: ${err.message}`);
  }
  return { projectId: project.id, repo, deviceToken, chats: Object.fromEntries(Object.entries(created).map(([k, v]) => [k, { workspaceId: v.workspaceId, sessionId: v.sessionId }])) };
}

/** Pairs a made-up device through the real invite flow (it answers the host's Allow itself). */
async function pairDevice(call, api, deviceName, deviceKind) {
  const invite = await call("POST", "/auth/invites");
  const grant = new URL(invite.link).searchParams.get("g") ?? invite.code;
  // As if it came in over Tailscale Serve from the MacBook Air (address shown in the devices list).
  const via = { "x-forwarded-for": DEMO_DEVICE_ADDRESS, "tailscale-user-login": "demo@example.com" };
  const pairing = fetch(`${api}/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", ...via },
    body: JSON.stringify({ grant, deviceName, deviceKind }),
  }).then((r) => r.json());
  for (let i = 0; i < 40; i++) {
    const pending = await call("GET", "/auth/pending");
    if (pending.length) {
      await call("POST", `/auth/pending/${pending[0].id}`, { allow: true });
      break;
    }
    await sleep(150);
  }
  const result = await pairing;
  if (!result?.token) throw new Error(`no token: ${JSON.stringify(result)}`);
  await touchDevice(api, result.token);
  return result.token;
}

const DEMO_DEVICE_ADDRESS = "100.88.12.40";

/** A request with a paired device's token, so the devices list shows it as just seen. */
export async function touchDevice(api, token) {
  await fetch(`${api}/settings`, { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": DEMO_DEVICE_ADDRESS, "tailscale-user-login": "demo@example.com" } }).catch(() => {});
}
