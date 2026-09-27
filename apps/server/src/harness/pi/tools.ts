/**
 * pi's tools → harness-neutral tool calls (I-068).
 *
 * pi's built-in tools (`bash`, `powershell`, `read`, `write`, `edit`, `grep`, `find`, `ls`) get a
 * canonical {@link ToolKind} and a normalized {@link ToolInput}; the edit tool's display diff
 * (`details.diff`) becomes normalized {@link DiffLine}s. ext-kit's `spawn_agent` is a `task`
 * (`agentName` + the task's first line). ext-kit's web tools are `web`, its agent-teams tools
 * `agent`, and MCP tools (`mcp`, `mcpScript`, `mcp__<server>`) `mcp` (I-089); its Glade chat tools
 * (`find_chats`, `read_chat`, `open_chat`) are `chat` (I-099). Anything else stays
 * `other` and is shown from its raw name/args. Pure; no I/O.
 */
import type { DiffLine, ToolCallBlock, ToolEdit, ToolInput, ToolKind } from "@glade/protocol";

type Args = Record<string, unknown>;

const KINDS = new Map<string, ToolKind>([
  ["bash", "shell"],
  ["powershell", "shell"],
  ["read", "read"],
  ["write", "write"],
  ["edit", "edit"],
  ["grep", "search"],
  ["find", "search"],
  ["ls", "list"],
  // ext-kit agent-teams (I-084): shown as the spawned agent's card.
  ["spawn_agent", "task"],
  // ext-kit web tools, agent-teams tools and the MCP adapter (I-089).
  ["web_search", "web"],
  ["fetch_content", "web"],
  ["get_search_content", "web"],
  ["source_check", "web"],
  ["message_agent", "agent"],
  ["close_agent", "agent"],
  ["list_agents", "agent"],
  ["mcp", "mcp"],
  ["mcpScript", "mcp"],
  // ext-kit's Glade chat tools (I-099).
  ["find_chats", "chat"],
  ["read_chat", "chat"],
  ["open_chat", "chat"],
]);

/** Canonical kind of a pi tool (by name). */
export function piToolKind(name: string): ToolKind {
  return KINDS.get(name) ?? (name.startsWith("mcp__") ? "mcp" : "other");
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);

/** web: a search's query (one or several), a fetched URL, or what a results lookup looked for. */
function webInput(name: string, a: Args): ToolInput {
  const urls = [str(a.url), ...strList(a.urls)].filter((u): u is string => !!u);
  const queries = [str(a.query), ...strList(a.queries)].filter((q): q is string => !!q);
  switch (name) {
    case "fetch_content":
      return compact({ url: urls.length > 1 ? `${urls[0]} (+${urls.length - 1} more)` : urls[0] });
    case "source_check":
      return compact({ query: str(a.claim) ?? queries[0] });
    case "get_search_content": {
      const find = Array.isArray(a.findText) ? strList(a.findText).join(", ") : str(a.findText);
      return compact({ description: find ? `looking for "${find}"` : str(a.query) ?? str(a.url) ?? "saved results" });
    }
    default:
      return compact({ query: queries.join(" · ") || undefined });
  }
}

/** agent: who was messaged/closed, and a preview of the message. */
function agentInput(name: string, a: Args): ToolInput {
  if (name === "list_agents") return { agentAction: "list" };
  if (name === "close_agent") return compact({ agentAction: "close", agentName: str(a.name) });
  return compact({ agentAction: "message", agentName: str(a.to), description: firstLine(a.text) });
}

/** chat: the search query, or the chat read/opened (its title is only in the result). */
function chatInput(name: string, a: Args): ToolInput {
  if (name === "find_chats") return compact({ chatAction: "find", query: str(a.query) });
  return compact({ chatAction: name === "open_chat" ? "open" : "read", chatId: str(a.id) });
}

/** mcp: the server and tool, or what the gateway call did (search, describe, a script…). */
function mcpInput(name: string, a: Args): ToolInput {
  if (name.startsWith("mcp__")) return compact({ server: name.slice("mcp__".length).replace(/_/g, "-"), tool: str(a.tool) });
  if (name === "mcpScript") return compact({ description: "script" });
  if (str(a.tool)) return compact({ server: str(a.server), tool: str(a.tool) });
  if (str(a.search)) return compact({ query: str(a.search) });
  if (str(a.describe)) return compact({ description: `described ${str(a.describe)}` });
  if (str(a.action)) return compact({ server: str(a.server), description: str(a.action) });
  return compact({ server: str(a.server ?? a.connect), description: str(a.server ?? a.connect) ? "listed tools" : "status" });
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** First non-empty line of a string (trimmed); undefined otherwise. */
function firstLine(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return v.split("\n").map((l) => l.trim()).find(Boolean);
}

/** Drop undefined fields so the input serializes (and compares) compactly. */
function compact(input: ToolInput): ToolInput {
  const out: ToolInput = {};
  for (const [key, value] of Object.entries(input) as Array<[keyof ToolInput, unknown]>) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

const isEdit = (v: unknown): v is ToolEdit =>
  !!v && typeof v === "object" && typeof (v as ToolEdit).oldText === "string" && typeof (v as ToolEdit).newText === "string";

/**
 * pi's edit args in every shape pi accepts: `{edits:[…]}`, `edits` as a JSON string (some
 * models send that), a single `edits` object, or the legacy top-level `{oldText,newText}`.
 */
export function piEdits(args: Args | undefined): ToolEdit[] {
  if (!args) return [];
  let edits: unknown = args.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      edits = undefined;
    }
  }
  if (Array.isArray(edits)) return edits.filter(isEdit).map((e) => ({ oldText: e.oldText, newText: e.newText }));
  if (isEdit(edits)) return [{ oldText: edits.oldText, newText: edits.newText }];
  if (isEdit(args)) return [{ oldText: args.oldText, newText: args.newText }];
  return [];
}

export interface PiToolInputOptions {
  /**
   * Args are partial (still streaming): keep only the short fields a summary needs, never the
   * bulky ones (`content`, `edits`) that would be re-sent with every delta.
   */
  partial?: boolean;
}

/** Normalized input of a pi tool call; `undefined` for tools without a canonical shape. */
export function piToolInput(name: string, args: Args | undefined, options: PiToolInputOptions = {}): ToolInput | undefined {
  const a = args ?? {};
  const full = !options.partial;
  switch (piToolKind(name)) {
    case "shell":
      return compact({ command: str(a.command) });
    case "read":
      return compact({ path: str(a.path), offset: num(a.offset), limit: num(a.limit) });
    case "write":
      return compact({ path: str(a.path), content: full && typeof a.content === "string" ? a.content : undefined });
    case "edit":
      return compact({ path: str(a.path), edits: full ? piEdits(a) : undefined });
    case "search":
      return compact({ pattern: str(a.pattern), path: str(a.path), glob: str(a.glob) });
    case "list":
      return compact({ path: str(a.path) });
    case "task":
      return compact({ agentName: str(a.name), description: str(firstLine(a.task)) });
    case "web":
      return webInput(name, a);
    case "agent":
      return agentInput(name, a);
    case "mcp":
      return mcpInput(name, a);
    case "chat":
      return chatInput(name, a);
    default:
      return undefined;
  }
}

/** A complete pi tool call as a protocol block. */
export function piToolCallBlock(id: string, name: string, args: Args): ToolCallBlock {
  const input = piToolInput(name, args);
  return { type: "toolCall", id, name, kind: piToolKind(name), ...(input ? { input } : {}), args };
}

/**
 * Best-effort parse of streaming argument JSON: the whole object once it's complete, otherwise
 * every string field whose value is already complete (so e.g. a command shows before the call
 * has finished streaming).
 */
export function partialJsonArgs(argsText: string | undefined): Args {
  if (!argsText) return {};
  try {
    const parsed: unknown = JSON.parse(argsText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Args;
  } catch {
    /* incomplete - fall through */
  }
  const out: Args = {};
  const re = /"([A-Za-z_][\w]*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  for (const m of argsText.matchAll(re)) {
    try {
      out[m[1]!] = JSON.parse(`"${m[2]!}"`) as string;
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Parse pi's display diff (the edit tool's `details.diff`): lines are `+NN text`, `-NN text`,
 * ` NN text` (context, old line number) or ` <pad> ...` for skipped context.
 */
export function parsePiDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const raw of diff.split("\n")) {
    if (raw === "") continue;
    const sign = raw[0];
    const m = /^(\s*)(\d*) ?(.*)$/.exec(raw.slice(1));
    if (!m) continue;
    const [, , digits, text = ""] = m;
    if (!digits && text.trim() === "...") {
      out.push({ type: "gap", text: "" });
      continue;
    }
    const n = digits ? Number(digits) : undefined;
    if (sign === "+") out.push({ type: "add", text, ...(n !== undefined ? { newLine: n } : {}) });
    else if (sign === "-") out.push({ type: "del", text, ...(n !== undefined ? { oldLine: n } : {}) });
    else out.push({ type: "context", text, ...(n !== undefined ? { oldLine: n } : {}) });
  }
  return out;
}

/** Normalized diff of a finished pi tool call, when pi reported one (edit's `details.diff`). */
export function piToolDiff(name: string, details: unknown): DiffLine[] | undefined {
  if (piToolKind(name) !== "edit" || !details || typeof details !== "object") return undefined;
  const diff = (details as { diff?: unknown }).diff;
  if (typeof diff !== "string" || !diff) return undefined;
  const lines = parsePiDiff(diff);
  return lines.length ? lines : undefined;
}
