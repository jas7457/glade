/**
 * ACP tool calls → Glade's normalized tool blocks and results (I-068, I-119).
 *
 * ACP reports a tool call as a human title, an optional `kind` (read, edit, delete, move, search,
 * execute, think, fetch, switch_mode, other), the affected `locations`, the agent's `rawInput`
 * and typed `content` (text/image content, diffs, terminals). Kinds map to Glade's canonical
 * kinds; the input is normalized best-effort from `rawInput` (common field names), the locations
 * and the diffs. Anything without a canonical shape is `other` and shown by its title.
 */
import type { ToolCall, ToolCallContent, ToolCallUpdate, ToolKind as AcpToolKind } from "@agentclientprotocol/sdk";
import type { ImageBlock, ToolCallBlock, ToolEdit, ToolInput, ToolKind, ToolResult, ToolStatus } from "@glade/protocol";

/** Everything known about one tool call so far (tool_call + tool_call_updates merged). */
export interface AcpToolState {
  toolCallId: string;
  title: string;
  kind: AcpToolKind | null;
  status: ToolCall["status"] | null;
  content: ToolCallContent[];
  locations: Array<{ path: string; line?: number | null }>;
  rawInput: unknown;
  rawOutput: unknown;
}

export function newToolState(call: ToolCall | ToolCallUpdate): AcpToolState {
  return mergeToolUpdate(
    { toolCallId: call.toolCallId, title: "", kind: null, status: null, content: [], locations: [], rawInput: undefined, rawOutput: undefined },
    call,
  );
}

/** Apply a `tool_call_update` (or a repeated `tool_call`): only the fields it sets change. */
export function mergeToolUpdate(state: AcpToolState, update: ToolCall | ToolCallUpdate): AcpToolState {
  return {
    ...state,
    ...(update.title != null ? { title: update.title } : {}),
    ...(update.kind != null ? { kind: update.kind } : {}),
    ...(update.status != null ? { status: update.status } : {}),
    ...(update.content != null ? { content: update.content } : {}),
    ...(update.locations != null ? { locations: update.locations } : {}),
    ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
    ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
  };
}

type Args = Record<string, unknown>;

function asArgs(value: unknown): Args {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Args) : {};
}

function str(args: Args, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

function num(args: Args, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function diffs(state: AcpToolState): Array<{ path: string; oldText?: string | null; newText: string }> {
  return state.content.flatMap((c) => (c.type === "diff" ? [c] : []));
}

/** Glade's kind for an ACP tool call. `edit` with only new files is a `write`. */
export function acpToolKind(state: AcpToolState): ToolKind {
  switch (state.kind) {
    case "read":
      return "read";
    case "edit": {
      const d = diffs(state);
      return d.length > 0 && d.every((x) => x.oldText == null) ? "write" : "edit";
    }
    case "search":
      return "search";
    case "execute":
      return "shell";
    case "fetch":
      return "web";
    default:
      // delete, move, think, switch_mode, other: no canonical shape in Glade.
      return "other";
  }
}

/** Normalized input for the kind (I-068); `undefined` for `other`. */
export function acpToolInput(state: AcpToolState, kind: ToolKind): ToolInput | undefined {
  const args = asArgs(state.rawInput);
  const location = state.locations[0];
  const path = str(args, "path", "file_path", "filePath", "abs_path", "absolute_path", "file") ?? location?.path ?? diffs(state)[0]?.path;
  switch (kind) {
    case "shell": {
      const raw = args.command ?? args.cmd;
      const command = Array.isArray(raw) ? raw.filter((p) => typeof p === "string").join(" ") : typeof raw === "string" ? raw : undefined;
      return { command: command ?? state.title, ...(command ? { description: state.title } : {}) };
    }
    case "read": {
      const offset = num(args, "offset", "line", "start_line") ?? location?.line ?? undefined;
      const limit = num(args, "limit", "lines");
      return { ...(path ? { path } : {}), ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) };
    }
    case "write": {
      const content = str(args, "content", "text") ?? diffs(state)[0]?.newText;
      return { ...(path ? { path } : {}), ...(content !== undefined ? { content } : {}) };
    }
    case "edit": {
      const edits: ToolEdit[] = diffs(state).map((d) => ({ oldText: d.oldText ?? "", newText: d.newText }));
      if (!edits.length) {
        const oldText = str(args, "old_string", "oldText", "old_str");
        const newText = str(args, "new_string", "newText", "new_str");
        if (oldText !== undefined && newText !== undefined) edits.push({ oldText, newText });
      }
      return { ...(path ? { path } : {}), ...(edits.length ? { edits } : {}) };
    }
    case "search": {
      const pattern = str(args, "pattern", "query", "regex", "glob") ?? state.title;
      const glob = str(args, "glob", "include");
      return { pattern, ...(path ? { path } : {}), ...(glob && glob !== pattern ? { glob } : {}) };
    }
    case "web": {
      const url = str(args, "url", "uri");
      const query = str(args, "query", "q");
      return url || query ? { ...(url ? { url } : {}), ...(query ? { query } : {}) } : { description: state.title };
    }
    default:
      return undefined;
  }
}

/** The tool call's block in the assistant message. `name` is ACP's title (shown for `other`). */
export function acpToolBlock(state: AcpToolState): ToolCallBlock {
  const kind = acpToolKind(state);
  const input = acpToolInput(state, kind);
  const args = asArgs(state.rawInput);
  return {
    type: "toolCall",
    id: state.toolCallId,
    name: state.title || state.kind || "tool",
    kind,
    ...(input ? { input } : {}),
    args: { ...args, ...(state.locations.length ? { locations: state.locations.map((l) => l.path) } : {}) },
  };
}

export function acpToolStatus(state: AcpToolState): ToolStatus {
  if (state.status === "completed") return "done";
  if (state.status === "failed") return "error";
  return "running";
}

/** Text of a tool call's content blocks (and raw output as a fallback). */
export function acpToolOutput(state: AcpToolState): { output: string; images?: ImageBlock[] } {
  const parts: string[] = [];
  const images: ImageBlock[] = [];
  for (const item of state.content) {
    if (item.type === "content") {
      const block = item.content;
      if (block.type === "text") parts.push(block.text);
      else if (block.type === "image") images.push({ type: "image", mimeType: block.mimeType, data: block.data });
      else if (block.type === "resource_link") parts.push(block.uri);
      else if (block.type === "resource" && "text" in block.resource) parts.push(block.resource.text);
    } else if (item.type === "terminal") {
      parts.push(`[terminal ${item.terminalId}]`);
    }
  }
  if (!parts.length && state.rawOutput !== undefined && state.rawOutput !== null) {
    const raw = state.rawOutput;
    const text = typeof raw === "string" ? raw : typeof (raw as Args).output === "string" ? ((raw as Args).output as string) : JSON.stringify(raw, null, 2);
    parts.push(text);
  }
  return { output: parts.join("\n"), ...(images.length ? { images } : {}) };
}

export function acpToolResult(state: AcpToolState): ToolResult {
  const { output, images } = acpToolOutput(state);
  return {
    toolCallId: state.toolCallId,
    toolName: state.title || state.kind || "tool",
    status: acpToolStatus(state),
    output,
    ...(images ? { images } : {}),
    ...(state.rawOutput !== undefined ? { details: state.rawOutput } : {}),
  };
}

/** One line describing a tool call for a permission card ("Run `ls`", "Edit src/a.ts"). */
export function acpToolSummary(state: AcpToolState): string | undefined {
  const kind = acpToolKind(state);
  const input = acpToolInput(state, kind);
  if (!input) return state.locations[0]?.path;
  if (input.command && input.command !== state.title) return `$ ${input.command}`;
  if (input.path) return input.path;
  if (input.url) return input.url;
  return undefined;
}
