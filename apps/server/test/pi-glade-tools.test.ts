/**
 * I-116: Glade's own pi extension (`harness/pi/extension/glade-tools.ts`): which tools it registers
 * (main / sub-agent / "Use sub-agents" off), its identity handling, agent definitions, the agent
 * API calls behind the tools, and how `PiHarness` loads it (`-e`, `GLADE_TOOLS`, `GLADE_SUBAGENTS`).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_ENV, LEGACY_AGENT_ENV } from "@glade/protocol";
import { piChildEnv } from "../src/harness/pi/child-env.js";
import { extensionCandidates, gladeExtensionLaunch, gladeExtensionPath } from "../src/harness/pi/extension-path.js";
import gladeTools, {
  fetchSpawnableAgents,
  formatSpawnableAgent,
  packageAgentDirs,
  readIdentity,
  reportTools,
  spawnAgentSpecFor,
  registerGladeTools,
  takeIdentity,
  toolSpecsFor,
  type GladeIdentity,
  type PiExtensionApi,
} from "../src/harness/pi/extension/glade-tools.js";
import { PiHarness } from "../src/harness/pi/pi-harness.js";
import { piToolKind } from "../src/harness/pi/tools.js";

const IDENTITY_KEY = Symbol.for("glade.pi-extension.identity");
const forgetIdentity = () => delete (globalThis as unknown as Record<symbol, unknown>)[IDENTITY_KEY];

const names = (identity: Pick<GladeIdentity, "agentName" | "subagents">) => toolSpecsFor(identity).map((s) => s.name);

describe("glade-tools: which tools", () => {
  it("main agents get the sub-agent tools and the chat tools", () => {
    expect(names({ subagents: true })).toEqual([
      "spawn_agent",
      "message_agent",
      "list_agents",
      "close_agent",
      "find_chats",
      "read_chat",
      "open_chat",
    ]);
  });

  it("'Use sub-agents' off: only the chat tools", () => {
    expect(names({ subagents: false })).toEqual(["find_chats", "read_chat", "open_chat"]);
  });

  it("sub-agents get report_done + message_agent (whatever the setting), never spawn", () => {
    const expected = ["report_done", "message_agent", "find_chats", "read_chat", "open_chat"];
    expect(names({ agentName: "maya", subagents: true })).toEqual(expected);
    expect(names({ agentName: "maya", subagents: false })).toEqual(expected);
  });

  it("every tool but report_done is one Glade's tool mapping knows (cards, summaries)", () => {
    for (const spec of [...toolSpecsFor({ subagents: true }), ...toolSpecsFor({ agentName: "a", subagents: true })]) {
      if (spec.name === "report_done") continue;
      expect(piToolKind(spec.name), spec.name).not.toBe("other");
    }
  });
});

describe("glade-tools: identity", () => {
  beforeEach(forgetIdentity);
  afterEach(forgetIdentity);

  it("reads Glade's variables (AGENT_ENV), else the pre-rename ones, and the sub-agents switch", () => {
    expect(AGENT_ENV).toMatchObject({ url: "GLADE_URL", token: "GLADE_TOKEN", sessionId: "GLADE_SESSION_ID", agentName: "GLADE_AGENT_NAME" });
    expect(readIdentity({ GLADE_URL: "http://h:1/", GLADE_TOKEN: "t", GLADE_SESSION_ID: "s" })).toEqual({
      url: "http://h:1",
      token: "t",
      sessionId: "s",
      agentName: undefined,
      subagents: true,
    });
    expect(readIdentity({ [LEGACY_AGENT_ENV.url]: "u", [LEGACY_AGENT_ENV.token]: "t", [LEGACY_AGENT_ENV.agentName]: "n", GLADE_SUBAGENTS: "off" })).toMatchObject({
      agentName: "n",
      subagents: false,
    });
    expect(readIdentity({ GLADE_URL: "u" })).toBeUndefined();
  });

  it("consumes the variables (both names) but keeps GLADE_TOOLS for ext-kit, and remembers the identity for reloads", () => {
    const env: NodeJS.ProcessEnv = {
      GLADE_URL: "u",
      GLADE_TOKEN: "t",
      PI_UI_URL: "u",
      PI_UI_TOKEN: "t",
      GLADE_SUBAGENTS: "off",
      GLADE_TOOLS: "1",
      PATH: "/bin",
    };
    const first = takeIdentity(env);
    expect(first).toMatchObject({ url: "u", token: "t", subagents: false });
    expect(env).toEqual({ GLADE_TOOLS: "1", PATH: "/bin" });
    // pi may load the extension again in the same process (no module cache): same identity.
    expect(takeIdentity(env)).toEqual(first);
  });

  it("outside Glade: registers nothing", () => {
    const registered: string[] = [];
    const saved = { ...process.env };
    for (const key of Object.keys(process.env)) if (/^(GLADE|PI_UI)_/.test(key)) delete process.env[key];
    try {
      gladeTools({ registerTool: (t) => void registered.push(t.name), getAllTools: () => [], on: () => {} });
    } finally {
      Object.assign(process.env, saved);
    }
    expect(registered).toEqual([]);
  });
});

describe("glade-tools: pi packages' agent folders", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "glade-ext-home-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("local and npm packages from ~/.pi/agent/settings.json (git packages aren't searched)", () => {
    const agentDir = join(home, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["../../src/kit", "npm:@me/agents-pkg@1.2.0", "git:github.com/x/y", { source: "npm:plain" }] }));
    expect(packageAgentDirs(agentDir)).toEqual([
      join(home, "src", "kit", "agents"),
      join(agentDir, "npm", "node_modules", "@me", "agents-pkg", "agents"),
      join(agentDir, "npm", "node_modules", "plain", "agents"),
    ]);
    expect(packageAgentDirs(join(home, "nowhere"))).toEqual([]);
  });
});

describe("glade-tools: spawn_agent lists the agents (I-218)", () => {
  const list = {
    agents: [
      { name: "scout", description: "Fast read-only code search.\nUse before changing code.", harness: "claude", harnessLabel: "Claude Code", model: "haiku", readOnly: true },
      { name: "writer", description: "Writes docs.", harness: null, harnessLabel: null, model: null, readOnly: false },
    ],
    harnesses: [
      { id: "pi", label: "pi" },
      { id: "claude", label: "Claude Code" },
    ],
  };

  it("names, harness · model, read-only and the description in spawn_agent's description", () => {
    expect(formatSpawnableAgent(list.agents[0]!)).toBe("- scout (Claude Code · haiku, read-only): Fast read-only code search. Use before changing code.");
    expect(formatSpawnableAgent(list.agents[1]!)).toBe("- writer: Writes docs.");
    const spec = spawnAgentSpecFor(list);
    expect(spec.description).toContain("Available agents (pass the name as `agent`; omit it for a general sub-agent):\n- scout (Claude Code · haiku, read-only)");
    expect(spec.promptGuidelines!.join("\n")).toMatch(/use read-only agents for looking things up\. When the user names an agent, use that one\./);
    const props = (spec.parameters as { properties: Record<string, { description: string }> }).properties;
    expect(props.agent!.description).toMatch(/one of scout, writer/);
    expect(props.harness!.description).toMatch(/pi \(pi\), claude \(Claude Code\)/);
  });

  it("no agents: the plain spawn_agent (no listing, no choice guideline, no harness parameter)", () => {
    const spec = spawnAgentSpecFor({ agents: [], harnesses: [{ id: "pi", label: "pi" }] });
    expect(spec.description).not.toMatch(/Available agents/);
    expect(spec.promptGuidelines!.join("\n")).not.toMatch(/listed agents/);
    expect((spec.parameters as { properties: Record<string, unknown> }).properties.harness).toBeUndefined();
    expect(toolSpecsFor({ subagents: true }, list)[0]!.description).toMatch(/- scout/);
  });

  it("fetches the list with the token; failures list none", async () => {
    const seen: string[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      seen.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
      return new Response(JSON.stringify(list), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchSpawnableAgents({ url: "http://glade", token: "tok", subagents: true }, ok)).toEqual(list);
    expect(seen).toEqual(["http://glade/api/agents/definitions Bearer tok"]);
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await fetchSpawnableAgents({ url: "http://glade", token: "tok", subagents: true }, down)).toBeNull();
    const old = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    expect(await fetchSpawnableAgents({ url: "http://glade", token: "tok", subagents: true }, old)).toBeNull();
  });

  it("reports pi's tools and MCP servers to /tools", async () => {
    const posts: unknown[] = [];
    const f = (async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(init.body as string) });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const api: PiExtensionApi = { registerTool: () => {}, getAllTools: () => [{ name: "read" }, { name: "mcp__docs__search" }], getMcpServers: () => [{ name: "docs" }], on: () => {} };
    await reportTools(api, { url: "http://glade", token: "t", subagents: true }, f);
    expect(posts).toEqual([{ url: "http://glade/api/agents/tools", body: { tools: ["read", "mcp__docs__search"], mcpServers: ["docs"] } }]);
  });
});

describe("glade-tools: calls to the agent API", () => {
  type Tool = Parameters<PiExtensionApi["registerTool"]>[0];
  let tools: Map<string, Tool>;
  let requests: Array<{ url: string; method: string; auth: string | null; body: unknown }>;
  let reply: (path: string) => { status: number; body?: unknown };
  let cwd: string;

  beforeEach(() => {
    tools = new Map();
    requests = [];
    cwd = mkdtempSync(join(tmpdir(), "glade-ext-cwd-"));
    reply = () => ({ status: 204 });
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const fakeFetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    requests.push({ url, method: init.method!, auth: headers.authorization ?? null, body: init.body ? JSON.parse(init.body as string) : undefined });
    const { status, body } = reply(url.replace(/^.*\/api\/agents/, ""));
    return new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status });
  }) as unknown as typeof fetch;

  function register(identity: Partial<GladeIdentity> = {}) {
    const api: PiExtensionApi = {
      registerTool: (t) => void tools.set(t.name, t),
      getAllTools: () => [...tools.keys()].map((name) => ({ name })),
      on: () => {},
    };
    registerGladeTools(api, { url: "http://glade", token: "tok", subagents: true, ...identity }, fakeFetch);
  }
  const run = async (name: string, params: Record<string, unknown>) => {
    const result = await tools.get(name)!.execute("id", params, undefined, undefined, { cwd });
    return result.content[0]!.text;
  };

  it("spawn_agent posts to /spawn with the bearer token; the API's refusal becomes the result text", async () => {
    register();
    reply = () => ({ status: 200, body: { agent: { name: "scout-1" } } });
    expect(await run("spawn_agent", { name: "scout-1", task: "look" })).toBe(
      'Spawned "scout-1" in a new Glade tab. It closes when done. Its result will arrive as an [agent-teams] message; do not wait or poll.',
    );
    expect(requests[0]).toMatchObject({ url: "http://glade/api/agents/spawn", method: "POST", auth: "Bearer tok", body: { name: "scout-1", task: "look" } });

    reply = () => ({ status: 200, body: { agent: { name: "t3-research", displayName: "Leo" } } });
    expect(await run("spawn_agent", { name: "t3-research", task: "look" })).toMatch(/^Spawned Leo \("t3-research"\) in a new Glade tab\. /);
    expect(tools.get("spawn_agent")!.promptGuidelines).toContain(
      "Refer to sub-agents by their display name (e.g. Leo) when talking to the user; use the code name only as the id for message_agent/close_agent.",
    );

    reply = () => ({ status: 403, body: { error: "Sub-agents are turned off in Glade" } });
    expect(await run("spawn_agent", { name: "x", task: "t" })).toBe("Sub-agents are turned off in Glade");
    expect(await run("spawn_agent", { name: "x", task: "t", keep_open: true })).toMatch(/keep_open needs keep_open_reason/);
    reply = () => ({ status: 400, body: { error: 'Unknown agent "nope". Available: scout' } });
    expect(await run("spawn_agent", { name: "x", task: "t", agent: "nope" })).toBe('Unknown agent "nope". Available: scout');
  });

  it("spawn_agent sends the agent's name (the server resolves it, I-218) and names another harness", async () => {
    register({ harness: "pi" });
    reply = () => ({ status: 200, body: { agent: { name: "r", displayName: "Brandon", agent: "scout", harness: "claude" } } });
    expect(await run("spawn_agent", { name: "r", task: "t", agent: "scout" })).toMatch(/^Spawned Brandon \("r"\) \(agent: scout\) on Claude Code in a new Glade tab\. /);
    expect(requests[0]!.body).toEqual({ name: "r", task: "t", agent: "scout" });
    reply = () => ({ status: 200, body: { agent: { name: "q", agent: null, harness: "pi" } } });
    expect(await run("spawn_agent", { name: "q", task: "t", harness: "pi" })).toMatch(/^Spawned "q" in a new Glade tab\. /);
    expect(requests[1]!.body).toEqual({ name: "q", task: "t", harness: "pi" });
  });

  it("sub-agents: report_done and message_agent", async () => {
    register({ agentName: "maya" });
    reply = () => ({ status: 200, body: { closing: true } });
    expect(await run("report_done", { summary: "done" })).toMatch(/^Reported to main\. This agent stops/);
    expect(requests[0]).toMatchObject({ url: "http://glade/api/agents/report-done", body: { summary: "done" } });
    reply = () => ({ status: 204 });
    expect(await run("message_agent", { to: "main", text: "hi" })).toBe("Sent to main.");
    expect(tools.has("spawn_agent")).toBe(false);
  });

  it("list_agents, close_agent and the chat tools", async () => {
    register();
    reply = () => ({ status: 200, body: { agents: [{ name: "a", agent: null, status: "closed", tabOpen: false, userEngaged: false, keepOpenReason: null }] } });
    expect(await run("list_agents", {})).toMatch(/^Team:\n- a: closed \(tab closed\)\n\nAvailable agents:\n/);
    reply = (path) =>
      path === "/definitions"
        ? { status: 200, body: { agents: [{ name: "scout", description: "Looks.", harness: "codex", harnessLabel: "Codex", model: null, readOnly: true }], harnesses: [] } }
        : { status: 200, body: { agents: [] } };
    expect(await run("list_agents", {})).toBe("Team:\n(no sub-agents yet)\n\nAvailable agents:\n- scout (Codex, read-only): Looks.");
    reply = () => ({ status: 200, body: { agents: [{ name: "t3-research", displayName: "Leo", agent: "rev", status: "working", userEngaged: false, keepOpenReason: null }] } });
    expect(await run("list_agents", {})).toMatch(/^Team:\n- Leo \(t3-research\) \[rev\]: working\n/);
    reply = () => ({ status: 200, body: { closed: false, alreadyClosed: true } });
    expect(await run("close_agent", { name: "a" })).toBe("a is already closed.");

    const chat = { workspaceId: "w", sessionId: "s", sessionKind: "main", title: "Toolbar", workspaceTitle: "Toolbar", project: "glade", updatedAt: Date.UTC(2026, 8, 27), summary: "Added a button" };
    reply = () => ({ status: 200, body: { matches: [{ ...chat, snippet: "button", reason: "same topic", matchedBy: "model" }], confident: true, model: "haiku" } });
    expect(await run("find_chats", { query: "toolbar" })).toBe(
      '1 chat(s) (picked by haiku, confident about the first):\n\n1. "Toolbar" — project glade, last active 2026-09-27\nid: s (workspace w)\nsummary: Added a button\nwhy: same topic\nmatching text: button',
    );
    reply = () => ({ status: 200, body: { chat, messages: [], totalMessages: 0 } });
    expect(await run("read_chat", { id: "s" })).toMatch(/\(no messages yet\)$/);
    reply = () => ({ status: 200, body: { chat, windows: 1 } });
    expect(await run("open_chat", { id: "s" })).toBe('Opened "Toolbar" in Glade.');
  });

  it("Glade unreachable: a readable result, not a crash", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    registerGladeTools({ registerTool: (t) => void tools.set(t.name, t), getAllTools: () => [], on: () => {} }, { url: "u", token: "t", subagents: true }, failing);
    expect(await run("find_chats", { query: "x" })).toBe("Glade is unreachable (ECONNREFUSED)");
  });
});

describe("PiHarness loads the extension (I-116)", () => {
  it("finds the extension next to the harness in dev, or in pi-extension/ in the desktop bundle", () => {
    const path = gladeExtensionPath({});
    expect(path).toMatch(/harness\/pi\/extension\/glade-tools\.ts$/);
    expect(existsSync(path!)).toBe(true);
    expect(extensionCandidates("/app")).toEqual(["/app/extension/glade-tools.ts", "/app/pi-extension/glade-tools.ts"]);
    expect(gladeExtensionPath({ GLADE_PI_EXTENSION: "off" })).toBeNull();
    expect(gladeExtensionPath({ GLADE_PI_EXTENSION: "/nope.ts" })).toBeNull();
  });

  it("launch args/env: -e + GLADE_TOOLS, GLADE_SUBAGENTS=off when the setting is off, nothing without the file", () => {
    expect(gladeExtensionLaunch("/x.ts", true)).toEqual({ args: ["-e", "/x.ts"], env: { GLADE_TOOLS: "1" } });
    expect(gladeExtensionLaunch("/x.ts", false)).toEqual({ args: ["-e", "/x.ts"], env: { GLADE_TOOLS: "1", GLADE_SUBAGENTS: "off" } });
    expect(gladeExtensionLaunch(null, false)).toEqual({ args: [], env: {} });
  });

  it("GLADE_TOOLS / GLADE_SUBAGENTS are never inherited from the server's environment", () => {
    expect(piChildEnv({ GLADE_TOOLS: "1", GLADE_SUBAGENTS: "off", PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });

  describe("spawned processes", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "glade-ext-spawn-"));
      // Records argv + the Glade variables, answers every RPC request with success.
      writeFileSync(
        join(dir, "pi"),
        `#!/usr/bin/env node
const fs = require("fs");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("GLADE_")));
fs.appendFileSync(${JSON.stringify(join(dir, "calls.jsonl"))}, JSON.stringify({ args: process.argv.slice(2), env }) + "\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    const data = m.type === "get_available_models" ? { models: [] } : m.type === "get_messages" ? { messages: [] } : m.type === "get_commands" ? { commands: [] } : {};
    process.stdout.write(JSON.stringify({ type: "response", id: m.id, command: m.type, success: true, data }) + "\\n");
  }
});
`,
      );
      chmodSync(join(dir, "pi"), 0o755);
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const calls = () =>
      readFileSync(join(dir, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { args: string[]; env: Record<string, string> });
    const harness = (subagents: boolean) =>
      new PiHarness({
        command: join(dir, "pi"),
        utilityCwd: dir,
        subagents: () => subagents,
        extensionPath: () => "/ext/glade-tools.ts",
      });

    it("agent sessions get -e <extension> and GLADE_TOOLS=1; utility processes don't", async () => {
      const h = harness(true);
      const session = await h.openSession({ cwd: dir, sessionRef: null, env: { GLADE_URL: "u", GLADE_TOKEN: "t" } }).catch(() => null);
      await session?.dispose();
      await h.listModels();
      const [agent, utility] = calls();
      expect(agent!.args).toEqual(expect.arrayContaining(["--mode", "rpc", "-e", "/ext/glade-tools.ts"]));
      expect(agent!.env).toEqual({ GLADE_TOOLS: "1", GLADE_URL: "u", GLADE_TOKEN: "t" });
      expect(utility!.args).not.toContain("-e");
      expect(utility!.env).toEqual({});
    });

    it("'Use sub-agents' off adds GLADE_SUBAGENTS=off", async () => {
      const session = await harness(false).openSession({ cwd: dir, sessionRef: null }).catch(() => null);
      await session?.dispose();
      expect(calls()[0]!.env).toEqual({ GLADE_TOOLS: "1", GLADE_SUBAGENTS: "off" });
    });
  });
});
