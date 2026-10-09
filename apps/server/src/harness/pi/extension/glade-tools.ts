/**
 * Glade's own pi extension (I-116): sub-agent and chat tools for every pi process Glade starts.
 *
 * Loaded with `pi -e <this file>` by `PiHarness` (see `extension-path.ts`); pi compiles it with jiti,
 * so it stays a single self-contained TypeScript file: only `node:` imports (no `@glade/protocol`,
 * no `typebox`: parameters are plain JSON Schema, which pi validates too). It's copied as-is into
 * the desktop bundle (`apps/desktop/scripts/bundle-server.mjs`).
 *
 * Environment (set by Glade, `AGENT_ENV` in packages/protocol/src/agents.ts):
 *   GLADE_URL, GLADE_TOKEN, GLADE_SESSION_ID  the agent API identity of this process
 *   GLADE_AGENT_NAME                          only for sub-agents
 *   GLADE_SUBAGENTS=off                       the "Use sub-agents" setting is off
 *   GLADE_TOOLS=1                             this extension is loaded (ext-kit's agent-teams then
 *                                             registers nothing; left in place for it to read)
 *
 * Tools (names, parameters, descriptions and result texts match ext-kit's agent-teams Glade backend,
 * which provided them before, so Glade's tool mapping in `harness/pi/tools.ts` keeps working):
 *   main agent:  spawn_agent, message_agent, close_agent, list_agents (only when sub-agents are on)
 *   sub-agent:   report_done, message_agent
 *   both:        find_chats, read_chat, open_chat
 *
 * Agents (I-218): `spawn_agent` lists the agents the orchestrator can pick in its description
 * (`GET /api/agents/definitions` at load; Claude Code and Codex get the same list in-process) and
 * sends only the agent's name: the server resolves the definition and applies it. At session start
 * the extension reports pi's tools (`POST /api/agents/tools`) for the agent editor's tool picker.
 *
 * pi loads `-e` extensions before package extensions and the first registration of a tool name
 * wins, so an older ext-kit that still registers the same names inside Glade is shadowed. This
 * extension also consumes the identity variables (so nested `pi` runs started from bash can't act
 * as this session), which leaves an older agent-teams without a Glade identity: it registers nothing.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// ---------------------------------------------------------------------------------------------
// Minimal structural types for pi's extension API (the real ones live in pi's package, which
// isn't a dependency of Glade).
// ---------------------------------------------------------------------------------------------

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, never>;
}

interface ToolContext {
  cwd: string;
}

export interface ToolSpec {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: JsonSchema;
}

interface ToolDefinition extends ToolSpec {
  // `any`: pi passes params validated against `parameters` (plain JSON Schema, so no static type).
  execute(toolCallId: string, params: any, signal: unknown, onUpdate: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface PiExtensionApi {
  registerTool(tool: ToolDefinition): void;
  getAllTools(): Array<{ name: string }>;
  /** MCP servers registered by extensions (newer pi versions). */
  getMcpServers?(): Array<{ name: string }>;
  on(event: "session_start", handler: (event: unknown, ctx: { hasUI?: boolean; ui: { setTitle(title: string): void } }) => Promise<void> | void): void;
}

type JsonSchema = Record<string, unknown>;

const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = (description: string): JsonSchema => ({ type: "string", description });
const num = (description: string): JsonSchema => ({ type: "number", description });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });

export const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], details: {} });

const MAIN = "main";

// ---------------------------------------------------------------------------------------------
// Tool specs (kept identical to ext-kit's extensions/agent-teams/specs.ts)
// ---------------------------------------------------------------------------------------------

/**
 * An agent `spawn_agent` can start (I-218), as listed in its description (`GET /api/agents/definitions`,
 * mirrored by the server's `SpawnableAgent` in `harness/types.ts`).
 */
export interface SpawnableAgent {
  name: string;
  description: string;
  /** Harness id, `null` = the caller's (inherit). */
  harness: string | null;
  /** "Claude Code"; `null` with `harness`. */
  harnessLabel: string | null;
  /** Model as written (`haiku`, `gpt-5.4-mini`); `null` = inherit / the harness's sub-agent default. */
  model: string | null;
  /** Can't change files (Claude Code tools/permission mode, Codex read-only sandbox, pi tools). */
  readOnly: boolean;
}

/** What `GET /api/agents/definitions` answers: the agents, and the harnesses sub-agents can run on. */
export interface SpawnableAgentList {
  agents: SpawnableAgent[];
  harnesses: Array<{ id: string; label: string }>;
}

const BASE_SPAWN_GUIDELINES = [
  "Use spawn_agent only when the request splits into two or more substantial, independent workstreams that benefit from running in parallel, or needs a long isolated investigation that would flood your context. Do small, quick, or tightly sequential work yourself.",
  "Sub-agents do not see this conversation: give each spawn_agent task the goal, relevant file paths, constraints, and exactly what to report back.",
  "After spawn_agent, do not poll or sleep waiting for results. They arrive automatically as [agent-teams] messages; continue other work or end your turn.",
  "spawn_agent closes each sub-agent (its pane or tab) when it finishes. Set keep_open (with keep_open_reason) only when a specific follow-up is likely: you already plan a next step that builds on that agent's context (iterate on its draft, apply review feedback to its own work, phase 2 of the same task), or the user said they want to talk to it. 'Might be useful later' is not a reason; a different job gets a fresh, specialized agent.",
  "When an [agent-teams] result says an agent is still open, either send the planned follow-up with message_agent right away or call close_agent. Do not leave it idle.",
];

/** I-218: how the orchestrator picks an agent (only when there are agents to pick). */
const AGENT_CHOICE_GUIDELINES = [
  "When one of spawn_agent's listed agents fits the task, pass it as `agent` instead of starting a general sub-agent; use read-only agents for looking things up. When the user names an agent, use that one.",
];

const NAMES_GUIDELINE =
  "Refer to sub-agents by their display name (e.g. Leo) when talking to the user; use the code name only as the id for message_agent/close_agent.";

/** `- scout (Claude Code · haiku, read-only): Fast read-only code search…` */
export function formatSpawnableAgent(agent: SpawnableAgent): string {
  const traits = [[agent.harnessLabel ?? agent.harness, agent.model].filter(Boolean).join(" · "), agent.readOnly ? "read-only" : ""].filter(Boolean);
  const description = (agent.description ?? "").trim().replace(/\s+/g, " ") || "(no description)";
  return `- ${agent.name}${traits.length ? ` (${traits.join(", ")})` : ""}: ${description}`;
}

/** `spawn_agent` with the available agents (I-218) in its description and parameters. */
export function spawnAgentSpecFor(list?: SpawnableAgentList | null): ToolSpec {
  const agents = list?.agents ?? [];
  const harnesses = list?.harnesses ?? [];
  const listing = agents.length
    ? `\n\nAvailable agents (pass the name as \`agent\`; omit it for a general sub-agent):\n${agents.map(formatSpawnableAgent).join("\n")}`
    : "";
  return {
    name: "spawn_agent",
    label: "Spawn agent",
    description:
      "Start a sub-agent in its own pane or tab, next to this session. Returns immediately; the sub-agent's result arrives later as an [agent-teams] message. The user can watch and talk to it directly." +
      listing,
    promptSnippet: "Delegate an independent workstream to a sub-agent in its own pane or tab",
    promptGuidelines: [
      ...BASE_SPAWN_GUIDELINES,
      ...(agents.length ? AGENT_CHOICE_GUIDELINES : []),
      "Use list_agents to see the team's status and the available agents.",
      NAMES_GUIDELINE,
    ],
    parameters: obj(
      {
        name: str("Short unique name, e.g. 'auth-scout'. Lowercase letters, digits, dashes."),
        task: str("Complete, self-contained task description for the sub-agent."),
        agent: str(
          agents.length
            ? `Agent to use: one of ${agents.map((a) => a.name).join(", ")} (see the list above). Omit for a general agent.`
            : "Agent definition to use (see list_agents). Omit for a general agent.",
        ),
        ...(harnesses.length > 1
          ? {
              harness: str(
                `Run the sub-agent on another agent harness: ${harnesses.map((h) => `${h.id} (${h.label})`).join(", ")}. Default: the agent's own, else yours. Only when the user asks for one.`,
              ),
            }
          : {}),
        keep_open: bool(
          "Keep the sub-agent open after it reports done (default false: it closes). Requires keep_open_reason. Sub-agents the user typed in never auto-close.",
        ),
        keep_open_reason: str("The concrete follow-up you expect to send this agent, e.g. 'apply reviewer feedback to its draft'."),
      },
      ["name", "task"],
    ),
  };
}

/** `spawn_agent` without an agent list (Glade unreachable at load, or no agents). */
export const spawnAgentSpec: ToolSpec = spawnAgentSpecFor(null);

export const mainMessageAgentSpec: ToolSpec = {
  name: "message_agent",
  label: "Message agent",
  description: "Send a message to a running sub-agent. It is delivered between the sub-agent's tool calls.",
  parameters: obj({ to: str("Sub-agent name"), text: str("Message text") }, ["to", "text"]),
};

export const listAgentsSpec: ToolSpec = {
  name: "list_agents",
  label: "List agents",
  description: "Show team status (active and finished sub-agents) and the available agents.",
  parameters: obj({}),
};

export const closeAgentSpec: ToolSpec = {
  name: "close_agent",
  label: "Close agent",
  description:
    "Close a sub-agent and its pane or tab (after its current turn; forced if it does not stop). Closing one that is already closed is fine.",
  parameters: obj({ name: str("Sub-agent name") }, ["name"]),
};

export const reportDoneSpec: ToolSpec = {
  name: "report_done",
  label: "Report done",
  description:
    "Report your final result to the main session. Call exactly once when your task is complete. The main session only sees this summary.",
  promptGuidelines: [
    "Call report_done once your delegated task is complete, with a concise self-contained summary; the main session sees nothing else you write.",
  ],
  parameters: obj(
    {
      summary: str("What you did, files changed, key findings, and open issues."),
      keep_open: bool("Stay open even if auto-close is on (e.g. you expect follow-up)."),
    },
    ["summary"],
  ),
};

export const childMessageAgentSpec: ToolSpec = {
  name: "message_agent",
  label: "Message agent",
  description: `Send a message to the main session ("${MAIN}") or another sub-agent on this team.`,
  parameters: obj({ to: str(`"${MAIN}" or a sub-agent name`), text: str("Message text") }, ["to", "text"]),
};

const pastChatGuideline =
  'When the user refers to a past conversation or another chat ("the chat where we…", "what did we decide about…", "open that chat"), use find_chats to locate it, read_chat to see what was said, and open_chat only when they want to see it.';

export const findChatsSpec: ToolSpec = {
  name: "find_chats",
  label: "Find chats",
  description:
    "Search the user's Glade chats (all projects) for a past conversation, like Glade's ⌘K Ask: a fast model picks the best matches, with keyword matches as fallback. Returns chat ids, titles, project, last activity, a one-line summary and a matching snippet. This chat itself is left out. Not for searching files (use grep/find for code).",
  promptSnippet: "Find the user's past Glade chats by what they were about",
  promptGuidelines: [pastChatGuideline],
  parameters: obj(
    {
      query: str("What the chat was about, in the user's words, e.g. 'where we added the new toolbar button'."),
      limit: num("Max results (default 5, max 10)."),
    },
    ["query"],
  ),
};

export const readChatSpec: ToolSpec = {
  name: "read_chat",
  label: "Read chat",
  description:
    "Read another Glade chat: its summary plus its last user/assistant messages (text only, no tool output; long messages are cut). Use an id from find_chats. Does not start or change that chat.",
  parameters: obj(
    {
      id: str("Chat id (sessionId from find_chats; a workspaceId also works)."),
      limit: num("How many of the last messages (default 10, max 40)."),
    },
    ["id"],
  ),
};

export const openChatSpec: ToolSpec = {
  name: "open_chat",
  label: "Open chat",
  description:
    "Show a chat in the user's Glade window (like picking it in ⌘K). Only when the user wants to see or switch to it; the current chat keeps running.",
  parameters: obj({ id: str("Chat id (sessionId from find_chats; a workspaceId also works).") }, ["id"]),
};

// ---------------------------------------------------------------------------------------------
// Identity and which tools to register (pure, tested in apps/server/test/pi-glade-tools.test.ts)
// ---------------------------------------------------------------------------------------------

export interface GladeIdentity {
  url: string;
  token: string;
  sessionId?: string;
  /** Set for sub-agents. */
  agentName?: string;
  /** The "Use sub-agents" setting (GLADE_SUBAGENTS); only affects main agents. */
  subagents: boolean;
  /** The calling harness's id (`pi`, `claude`, `codex`): spawn results name another one (I-217). */
  harness?: string;
}

const PREFIXES = ["GLADE_", "PI_UI_"] as const;
const NAMES = ["URL", "TOKEN", "SESSION_ID", "AGENT_NAME"] as const;
/** Survives pi loading this file again in the same process (jiti, no module cache). */
const IDENTITY_KEY = Symbol.for("glade.pi-extension.identity");

/** Reads (without consuming) the identity from `env`; undefined outside Glade. */
export function readIdentity(env: NodeJS.ProcessEnv): GladeIdentity | undefined {
  const get = (name: (typeof NAMES)[number]) => env[`GLADE_${name}`] || env[`PI_UI_${name}`] || undefined;
  const url = get("URL");
  const token = get("TOKEN");
  if (!url || !token) return undefined;
  return {
    url: url.replace(/\/+$/, ""),
    token,
    sessionId: get("SESSION_ID"),
    agentName: get("AGENT_NAME"),
    subagents: env.GLADE_SUBAGENTS !== "off",
  };
}

/**
 * This process's identity, consumed from `env` on first use (both name sets) so processes the agent
 * starts can't act as this session, and remembered for later loads of this file in the process.
 */
export function takeIdentity(env: NodeJS.ProcessEnv = process.env): GladeIdentity | undefined {
  const store = globalThis as unknown as Record<symbol, GladeIdentity | undefined>;
  const identity = readIdentity(env) ?? store[IDENTITY_KEY];
  if (!identity) return undefined;
  store[IDENTITY_KEY] = identity;
  for (const prefix of PREFIXES) for (const name of NAMES) delete env[prefix + name];
  delete env.GLADE_SUBAGENTS;
  return identity;
}

/** Tool specs this process gets (`agents`: what spawn_agent lists, I-218). */
export function toolSpecsFor(identity: Pick<GladeIdentity, "agentName" | "subagents">, agents?: SpawnableAgentList | null): ToolSpec[] {
  const chat = [findChatsSpec, readChatSpec, openChatSpec];
  if (identity.agentName) return [reportDoneSpec, childMessageAgentSpec, ...chat];
  if (!identity.subagents) return chat;
  return [agents ? spawnAgentSpecFor(agents) : spawnAgentSpec, mainMessageAgentSpec, listAgentsSpec, closeAgentSpec, ...chat];
}

/** Names of every tool this extension can register (left out of the tool lists it reports). */
export const GLADE_TOOL_NAMES: readonly string[] = [
  ...new Set([...toolSpecsFor({ subagents: true }), ...toolSpecsFor({ agentName: "a", subagents: true })].map((t) => t.name)),
];

// ---------------------------------------------------------------------------------------------
// pi packages' agent folders (used by the server's agent discovery, `services/agent-defs`)
// ---------------------------------------------------------------------------------------------

/**
 * `agents/` folders of the pi packages in `~/.pi/agent/settings.json` (e.g. ext-kit ships
 * worker/scout/reviewer/researcher there): local paths (relative to `~/.pi/agent`) and `npm:`
 * packages (installed under `~/.pi/agent/npm/node_modules`). git packages aren't searched.
 */
export function packageAgentDirs(agentDir: string): string[] {
  let packages: unknown;
  try {
    packages = (JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as { packages?: unknown }).packages;
  } catch {
    return [];
  }
  if (!Array.isArray(packages)) return [];
  const dirs: string[] = [];
  for (const entry of packages) {
    const source = typeof entry === "string" ? entry : (entry as { source?: unknown } | null)?.source;
    if (typeof source !== "string") continue;
    let root: string | undefined;
    if (source.startsWith("npm:")) {
      const spec = source.slice(4);
      const name = spec.startsWith("@") ? spec.split("@").slice(0, 2).join("@") : spec.split("@")[0]!;
      root = join(agentDir, "npm", "node_modules", name);
    } else if (!/^[a-z]+:/i.test(source)) {
      const expanded = source.startsWith("~/") ? join(homedir(), source.slice(2)) : source;
      root = isAbsolute(expanded) ? expanded : resolve(agentDir, expanded);
    }
    if (root) dirs.push(join(root, "agents"));
  }
  return dirs;
}

// ---------------------------------------------------------------------------------------------
// Agent API client (shapes mirror packages/protocol/src/agents.ts and chat-tools.ts)
// ---------------------------------------------------------------------------------------------

interface ChatInfo {
  workspaceId: string;
  sessionId: string;
  sessionKind: "main" | "subagent";
  title: string;
  workspaceTitle: string;
  project: string | null;
  updatedAt: number;
  summary: string | null;
}

interface ChatMatch extends ChatInfo {
  snippet: string | null;
  reason: string;
  matchedBy: "model" | "keyword";
}

interface AgentInfo {
  name: string;
  /** Fun name the user sees (I-120), e.g. "Leo"; absent on older servers. */
  displayName?: string;
  /** The harness it runs on (I-217). */
  harness?: string;
  sessionId: string;
  agent: string | null;
  task: string;
  status: "working" | "idle" | "done" | "closed";
  keepOpenReason: string | null;
  userEngaged: boolean;
  spawnedAt: number;
  doneAt: number | null;
  result: string | null;
  tabOpen?: boolean;
}

class ApiError extends Error {}

type Call = <T>(path: string, body?: unknown) => Promise<T>;

function client(id: GladeIdentity, fetchImpl: typeof fetch = fetch): Call {
  return async function call<T>(path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${id.url}/api/agents${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${id.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiError(`Glade is unreachable (${(err as Error)?.message ?? err})`);
    }
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(data?.error || `Glade returned ${res.status}`);
    return data as T;
  };
}

/** Run an API call; errors become the tool's text result. */
async function attempt(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return text(err instanceof ApiError ? err.message : `agent-teams: ${(err as Error)?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

/**
 * pi's factory (pi awaits it before the session starts): the agents spawn_agent lists come from
 * Glade first (a short timeout; without them spawn_agent still works, it just lists none), and
 * pi's tools are reported to Glade once the session has started (every extension loaded by then).
 */
export default async function gladeTools(pi: PiExtensionApi): Promise<void> {
  const identity = takeIdentity();
  if (!identity) return; // not started by Glade: register nothing
  const agents = !identity.agentName && identity.subagents ? await fetchSpawnableAgents(identity) : null;
  registerGladeTools(pi, { harness: "pi", ...identity }, undefined, agents);
  pi.on("session_start", () => reportTools(pi, identity));
}

/** `GET /api/agents/definitions`; `null` when Glade doesn't answer in time (or is older). */
export async function fetchSpawnableAgents(identity: GladeIdentity, fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<SpawnableAgentList | null> {
  try {
    const res = await fetchImpl(`${identity.url}/api/agents/definitions`, {
      headers: { authorization: `Bearer ${identity.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<SpawnableAgentList>;
    return { agents: Array.isArray(data.agents) ? data.agents : [], harnesses: Array.isArray(data.harnesses) ? data.harnesses : [] };
  } catch {
    return null;
  }
}

/** Tell Glade which tools pi has (I-218: the agent editor's tool picker); best effort. */
export async function reportTools(pi: PiExtensionApi, identity: GladeIdentity, fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    const tools = pi.getAllTools().map((t) => t.name);
    const mcpServers = pi.getMcpServers?.().map((s) => s.name) ?? [];
    await fetchImpl(`${identity.url}/api/agents/tools`, {
      method: "POST",
      headers: { authorization: `Bearer ${identity.token}`, "content-type": "application/json" },
      body: JSON.stringify({ tools, mcpServers }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // only the tool picker misses out
  }
}

/**
 * Register Glade's tools on `pi` (or the Claude Code / Codex adapters' stand-in). `agents`: what
 * spawn_agent lists (I-218); `null` lists none.
 */
export function registerGladeTools(pi: PiExtensionApi, identity: GladeIdentity, fetchImpl?: typeof fetch, agents?: SpawnableAgentList | null): void {
  const call = client(identity, fetchImpl);
  const executors = executorsFor(call, identity, agents ?? null);
  for (const spec of toolSpecsFor(identity, agents)) {
    const execute = executors[spec === childMessageAgentSpec ? "child_message_agent" : spec.name]!;
    pi.registerTool({ ...spec, execute });
  }
  if (identity.agentName) {
    const name = identity.agentName;
    pi.on("session_start", async (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.setTitle(`π team:${name}`);
    });
  }
}

/** Display names of the harnesses Glade knows (for spawn results naming another harness). */
const HARNESS_LABELS: Record<string, string> = { pi: "pi", claude: "Claude Code", codex: "Codex" };

type Execute = ToolDefinition["execute"];

function executorsFor(call: Call, identity: GladeIdentity, agents: SpawnableAgentList | null): Record<string, Execute> {
  const harnessLabel = (id: string) => agents?.harnesses?.find((h) => h.id === id)?.label ?? HARNESS_LABELS[id] ?? id;
  const sendMessage: Execute = (_id, params) =>
    attempt(async () => {
      await call("/message", { to: params.to, text: params.text });
      return text(`Sent to ${params.to}.`);
    });

  return {
    spawn_agent: (_id, params) =>
      attempt(async () => {
        const keepOpenReason = params.keep_open_reason?.trim();
        if (params.keep_open && !keepOpenReason)
          return text(
            "keep_open needs keep_open_reason: name the concrete follow-up you expect to send. If there isn't one, omit keep_open.",
          );
        // The server resolves the agent (I-218) and starts it on its harness (I-217).
        const { agent } = await call<{ agent: AgentInfo }>("/spawn", {
          name: params.name,
          task: params.task,
          agent: params.agent?.trim() || undefined,
          harness: params.harness?.trim() || undefined,
          keepOpen: params.keep_open || undefined,
          keepOpenReason: params.keep_open ? keepOpenReason : undefined,
        });
        const elsewhere = agent.harness && identity.harness && agent.harness !== identity.harness ? ` on ${harnessLabel(agent.harness)}` : "";
        return text(
          `Spawned ${agent.displayName ? `${agent.displayName} ("${agent.name}")` : `"${agent.name}"`}${agent.agent ? ` (agent: ${agent.agent})` : ""}${elsewhere} in a new Glade tab. ${params.keep_open ? `Kept open for: ${keepOpenReason}.` : "It closes when done."} ` +
            "Its result will arrive as an [agent-teams] message; do not wait or poll.",
        );
      }),

    message_agent: sendMessage,
    child_message_agent: sendMessage,

    list_agents: () =>
      attempt(async () => {
        const { agents: team } = await call<{ agents: AgentInfo[] }>("");
        // The server's current list (agents may have been added or switched off since load).
        const available = await call<SpawnableAgentList>("/definitions").catch(() => agents);
        return text(formatTeam(team, Array.isArray(available?.agents) ? available.agents : []));
      }),

    close_agent: (_id, params) =>
      attempt(async () => {
        const { closed, alreadyClosed } = await call<{ closed: boolean; alreadyClosed?: boolean }>("/close", { name: params.name });
        if (alreadyClosed) return text(`${params.name} is already closed.`);
        return text(closed ? `Closed ${params.name} (its tab is gone).` : `${params.name} closes when its current turn ends.`);
      }),

    report_done: (_id, params) =>
      attempt(async () => {
        const { closing } = await call<{ closing: boolean }>("/report-done", {
          summary: params.summary,
          keepOpen: params.keep_open || undefined,
        });
        // Glade stops this agent when the turn ends; don't shut down ourselves (it would look like a crash).
        return text(
          closing
            ? "Reported to main. This agent stops when this turn ends. Stop here; do not add more output."
            : "Reported to main. This agent stays open; the user or main may follow up.",
        );
      }),

    find_chats: (_id, params) =>
      attempt(async () => {
        const res = await call<{ matches: ChatMatch[]; confident: boolean; model: string | null }>("/chats/find", {
          query: params.query,
          limit: params.limit,
        });
        if (!res.matches.length) return text(`No chats found for "${params.query}".`);
        const how = res.model ? `picked by ${res.model}${res.confident ? ", confident about the first" : ""}` : "keyword matches";
        return text(`${res.matches.length} chat(s) (${how}):\n\n${res.matches.map(formatMatch).join("\n\n")}`);
      }),

    read_chat: (_id, params) =>
      attempt(async () => {
        const res = await call<{
          chat: ChatInfo;
          messages: Array<{ role: "user" | "assistant"; text: string; timestamp: number; truncated?: boolean }>;
          totalMessages: number;
        }>("/chats/read", { id: params.id, limit: params.limit });
        const head = formatChat(res.chat);
        if (!res.messages.length) return text(`${head}\n\n(no messages yet)`);
        const shown =
          res.messages.length < res.totalMessages
            ? `Last ${res.messages.length} of ${res.totalMessages} messages:`
            : `All ${res.totalMessages} messages:`;
        const body = res.messages
          .map((m) => `[${m.role}${m.timestamp ? ` ${day(m.timestamp)}` : ""}]${m.truncated ? " (cut)" : ""}\n${m.text}`)
          .join("\n\n");
        return text(`${head}\n\n${shown}\n\n${body}`);
      }),

    open_chat: (_id, params) =>
      attempt(async () => {
        const { chat, windows } = await call<{ chat: ChatInfo; windows: number }>("/chats/open", { id: params.id });
        return text(
          windows > 0
            ? `Opened "${chat.title}" in Glade.`
            : `No Glade window is open; "${chat.title}" will not be shown. Tell the user its title instead.`,
        );
      }),
  };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function formatChat(c: ChatInfo): string {
  return [
    `"${c.title}" — ${c.project ? `project ${c.project}` : "no project"}, last active ${day(c.updatedAt)}${c.sessionKind === "subagent" ? " (sub-agent)" : ""}`,
    `id: ${c.sessionId} (workspace ${c.workspaceId})`,
    c.summary ? `summary: ${c.summary}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatMatch(m: ChatMatch, i: number): string {
  return [`${i + 1}. ${formatChat(m)}`, m.reason ? `why: ${m.reason}` : "", m.snippet ? `matching text: ${m.snippet}` : ""]
    .filter(Boolean)
    .join("\n");
}

function formatTeam(agents: AgentInfo[], available: SpawnableAgent[]): string {
  const team = agents.length
    ? agents
        .map(
          (s) =>
            `- ${s.displayName ? `${s.displayName} (${s.name})` : s.name}${s.agent ? ` [${s.agent}]` : ""}: ${s.status}${s.status === "closed" && s.tabOpen === false ? " (tab closed)" : ""}${s.userEngaged ? " (user engaged)" : ""}` +
            (s.keepOpenReason && s.status !== "closed" ? ` — kept open for: ${s.keepOpenReason}` : ""),
        )
        .join("\n")
    : "(no sub-agents yet)";
  return `Team:\n${team}\n\nAvailable agents:\n${available.length ? available.map(formatSpawnableAgent).join("\n") : "(none)"}`;
}
