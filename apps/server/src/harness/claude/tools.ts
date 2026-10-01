/**
 * Claude Code's tools → Glade's harness-neutral tool calls (I-068, I-173). Pure; no I/O.
 *
 *   Bash → shell · Read → read · Write → write · Edit / MultiEdit / NotebookEdit → edit
 *   Grep / Glob → search · LS → list · WebFetch / WebSearch → web
 *   Task / Agent (Claude's own sub-agents) → task (its description; no Glade agent card)
 *   mcp__glade__* (Glade's sub-agent and chat tools, `glade-tools.ts`) → like pi's (task/agent/chat)
 *   mcp__<server>__<tool> → mcp · anything else → other
 *
 * TodoWrite and the task-list tools (TaskCreate/TaskUpdate/TaskList/TaskGet) aren't shown as tool
 * calls: the translator turns them into the harness-neutral plan card. Neither is ExitPlanMode
 * (I-189): its plan is the "Proposed plan" card, its approval the "Ready to code?" card. Edit/Write results carry
 * `structuredPatch` hunks, normalized into `DiffLine`s.
 */
import type { DiffLine, ImageBlock, ToolCallBlock, ToolEdit, ToolInput, ToolKind } from "@glade/protocol";
import { partialJsonArgs, piToolInput, piToolKind } from "../pi/tools.js";

type Args = Record<string, unknown>;

/** The in-process MCP server with Glade's own tools (`glade-tools.ts`). */
export const GLADE_MCP_SERVER = "glade";

const KINDS = new Map<string, ToolKind>([
  ["Bash", "shell"],
  ["Read", "read"],
  ["Write", "write"],
  ["Edit", "edit"],
  ["MultiEdit", "edit"],
  ["NotebookEdit", "edit"],
  ["Grep", "search"],
  ["Glob", "search"],
  ["LS", "list"],
  ["WebFetch", "web"],
  ["WebSearch", "web"],
  ["Task", "task"],
  ["Agent", "task"],
]);

/** Tools shown as the plan card (or the proposed plan card) instead of tool calls. */
const PLAN_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "ExitPlanMode"]);

/** Claude Code's tool that ends Plan mode with a plan for the user to approve (I-189). */
export const EXIT_PLAN_TOOL = "ExitPlanMode";

export function isPlanTool(name: string): boolean {
  return PLAN_TOOLS.has(name);
}

const gladePrefix = `mcp__${GLADE_MCP_SERVER}__`;

export function claudeToolKind(name: string): ToolKind {
  const kind = KINDS.get(name);
  if (kind) return kind;
  if (name.startsWith(gladePrefix)) return piToolKind(name);
  return name.startsWith("mcp__") ? "mcp" : "other";
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function compact(input: ToolInput): ToolInput {
  const out: ToolInput = {};
  for (const [key, value] of Object.entries(input) as Array<[keyof ToolInput, unknown]>) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

function firstLine(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return v.split("\n").map((l) => l.trim()).find(Boolean);
}

function edits(name: string, a: Args): ToolEdit[] {
  if (name === "MultiEdit" && Array.isArray(a.edits)) {
    return a.edits.flatMap((e) =>
      e && typeof e === "object" && typeof (e as Args).old_string === "string" && typeof (e as Args).new_string === "string"
        ? [{ oldText: (e as Args).old_string as string, newText: (e as Args).new_string as string }]
        : [],
    );
  }
  if (name === "NotebookEdit") return typeof a.new_source === "string" ? [{ oldText: "", newText: a.new_source }] : [];
  return typeof a.old_string === "string" && typeof a.new_string === "string" ? [{ oldText: a.old_string, newText: a.new_string }] : [];
}

/**
 * Normalized input of a Claude Code tool call; `undefined` for `other`. `partial` = the arguments
 * are still streaming: only the short summary fields (never file contents or edits).
 */
export function claudeToolInput(name: string, args: Args | undefined, options: { partial?: boolean } = {}): ToolInput | undefined {
  const a = args ?? {};
  const full = !options.partial;
  if (name.startsWith(gladePrefix)) return piToolInput(name, a, options);
  switch (claudeToolKind(name)) {
    case "shell":
      return compact({ command: str(a.command), description: str(a.description) });
    case "read":
      return compact({ path: str(a.file_path), offset: num(a.offset), limit: num(a.limit) });
    case "write":
      return compact({ path: str(a.file_path), content: full && typeof a.content === "string" ? a.content : undefined });
    case "edit": {
      const list = full ? edits(name, a) : [];
      return compact({ path: str(a.file_path) ?? str(a.notebook_path), edits: list.length ? list : undefined });
    }
    case "search":
      return compact({ pattern: str(a.pattern), path: str(a.path), glob: str(a.glob) });
    case "list":
      return compact({ path: str(a.path) });
    case "web":
      return name === "WebSearch" ? compact({ query: str(a.query) }) : compact({ url: str(a.url) });
    case "task":
      return compact({ description: str(a.description) ?? firstLine(a.prompt), agentDefinition: str(a.subagent_type) });
    case "mcp": {
      const rest = name.slice("mcp__".length);
      const split = rest.indexOf("__");
      return split > 0 ? compact({ server: rest.slice(0, split), tool: rest.slice(split + 2) }) : compact({ server: rest });
    }
    default:
      return undefined;
  }
}

/** A complete tool call block. */
export function claudeToolBlock(id: string, name: string, args: Args): ToolCallBlock {
  const input = claudeToolInput(name, args);
  return { type: "toolCall", id, name, kind: claudeToolKind(name), ...(input ? { input } : {}), args };
}

/** Streaming arguments → the partial input to show while the call streams. */
export function claudePartialInput(name: string, argsText: string): ToolInput | undefined {
  return claudeToolInput(name, partialJsonArgs(argsText), { partial: true });
}

export { partialJsonArgs };

interface Hunk {
  oldStart: number;
  newStart: number;
  lines: string[];
}

function isHunk(v: unknown): v is Hunk {
  const h = v as Hunk;
  return !!h && typeof h === "object" && typeof h.oldStart === "number" && typeof h.newStart === "number" && Array.isArray(h.lines);
}

/** Claude Code's `structuredPatch` (unified-diff hunks) → `DiffLine`s, gaps between hunks. */
export function structuredPatchDiff(patch: unknown): DiffLine[] | undefined {
  if (!Array.isArray(patch)) return undefined;
  const out: DiffLine[] = [];
  patch.filter(isHunk).forEach((hunk, i) => {
    if (i > 0 || hunk.oldStart > 1) out.push({ type: "gap", text: "" });
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const raw of hunk.lines) {
      if (typeof raw !== "string" || raw.startsWith("\\")) continue; // "\ No newline at end of file"
      const sign = raw[0];
      const text = raw.slice(1);
      if (sign === "+") out.push({ type: "add", text, newLine: newLine++ });
      else if (sign === "-") out.push({ type: "del", text, oldLine: oldLine++ });
      else out.push({ type: "context", text, oldLine: oldLine++, newLine: newLine++ });
    }
  });
  return out.some((l) => l.type !== "gap") ? out : undefined;
}

/** The diff of a finished Edit/MultiEdit/Write call, from its structured result. */
export function claudeToolDiff(name: string, structured: unknown): DiffLine[] | undefined {
  const kind = claudeToolKind(name);
  if ((kind !== "edit" && kind !== "write") || !structured || typeof structured !== "object") return undefined;
  return structuredPatchDiff((structured as Args).structuredPatch);
}

/** Text and images of a `tool_result` block's content. */
export function toolResultContent(content: unknown): { output: string; images?: ImageBlock[] } {
  if (typeof content === "string") return { output: content };
  if (!Array.isArray(content)) return { output: "" };
  const parts: string[] = [];
  const images: ImageBlock[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Args;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "image") {
      const source = b.source as Args | undefined;
      if (source?.type === "base64" && typeof source.data === "string") {
        images.push({ type: "image", mimeType: typeof source.media_type === "string" ? source.media_type : "image/png", data: source.data });
      }
    }
  }
  return { output: parts.join("\n"), ...(images.length ? { images } : {}) };
}

/** One line for a permission card: the command, file, URL or pattern the tool call is about. */
export function claudeToolSummary(name: string, args: Args): string | undefined {
  const input = claudeToolInput(name, args, { partial: true });
  if (!input) return undefined;
  if (input.command) return `$ ${input.command}`;
  return input.path ?? input.url ?? input.query ?? input.pattern ?? input.description;
}
