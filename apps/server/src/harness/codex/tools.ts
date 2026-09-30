/**
 * Codex's thread items → Glade's harness-neutral tool calls (I-068, I-177). Pure; no I/O.
 *
 *   commandExecution → shell (read / list / search when Codex parsed it as exactly one of those)
 *   fileChange       → one call per file: write (added) or edit (updated, deleted), with its diff
 *   mcpToolCall      → mcp (`mcp__<server>__<tool>`)
 *   dynamicToolCall  → Glade's own tools (`spawn_agent`, `find_chats`, …) like pi's
 *   webSearch        → web · imageView → read · collabAgentToolCall (Codex's sub-agents) → task
 *   subAgentActivity → task (a Codex sub-agent starting; GPT-6's multi-agent v2, I-179)
 *
 * Commands show without the login-shell wrapper Codex runs them in (`/bin/zsh -lc '…'`), like
 * Codex's own TUI (`displayCommand`); the raw command stays in the call's arguments.
 */
import type { DiffLine, ToolCallBlock, ToolInput, ToolKind } from "@glade/protocol";
import { piToolInput, piToolKind } from "../pi/tools.js";
import type { FileUpdateChange, JsonValue, ThreadItem } from "./protocol.js";

type Args = Record<string, unknown>;

export interface CodexToolCall {
  id: string;
  name: string;
  kind: ToolKind;
  input?: ToolInput;
  args: Args;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

function compact(input: ToolInput): ToolInput | undefined {
  const out: ToolInput = {};
  for (const [key, value] of Object.entries(input) as Array<[keyof ToolInput, unknown]>) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function asArgs(v: JsonValue | undefined): Args {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Args) : {};
}

/**
 * A command as the user reads it: `/bin/zsh -lc 'npm test'` → `npm test` (a single- or
 * double-quoted script for sh/bash/zsh with `-c` / `-lc`); anything else unchanged.
 */
export function displayCommand(command: string): string {
  const match = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(?:'((?:[^']|'\\'')*)'|"((?:[^"\\]|\\.)*)")$/s.exec(command.trim());
  if (!match) return command;
  if (match[1] !== undefined) return match[1].replace(/'\\''/g, "'");
  return match[2]!.replace(/\\([\\"$`])/g, "$1");
}

/** Id of the n-th file of a file change item (the first keeps the item's id). */
export function fileCallId(itemId: string, index: number): string {
  return index === 0 ? itemId : `${itemId}#${index}`;
}

/** Text an added file gets (from its diff). */
function addedText(diff: string): string {
  if (!/^@@ /m.test(diff)) return diff;
  return diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
}

function fileCall(itemId: string, index: number, change: FileUpdateChange): CodexToolCall {
  const kind: ToolKind = change.kind.type === "add" ? "write" : "edit";
  const movedTo = change.kind.type === "update" ? change.kind.move_path : null;
  const input = kind === "write" ? compact({ path: change.path, content: addedText(change.diff) }) : compact({ path: change.path, ...(movedTo ? { description: `→ ${movedTo}` } : {}) });
  return { id: fileCallId(itemId, index), name: "apply_patch", kind, ...(input ? { input } : {}), args: { path: change.path, kind: change.kind.type, ...(movedTo ? { move_path: movedTo } : {}) } };
}

/** The tool call(s) a Codex item shows as; empty for items that aren't tools. */
export function codexToolCalls(item: ThreadItem): CodexToolCall[] {
  switch (item.type) {
    case "commandExecution": {
      const args: Args = { command: item.command, cwd: item.cwd };
      const actions = item.commandActions ?? [];
      const only = actions.length === 1 ? actions[0]! : null;
      if (only?.type === "read") return [{ id: item.id, name: "shell", kind: "read", input: compact({ path: only.path || only.name })!, args }];
      if (only?.type === "listFiles") return [{ id: item.id, name: "shell", kind: "list", ...withInput(compact({ path: only.path ?? undefined })), args }];
      if (only?.type === "search") return [{ id: item.id, name: "shell", kind: "search", ...withInput(compact({ pattern: only.query ?? undefined, path: only.path ?? undefined })), args }];
      return [{ id: item.id, name: "shell", kind: "shell", ...withInput(compact({ command: displayCommand(item.command) })), args }];
    }
    case "fileChange":
      return item.changes.map((change, i) => fileCall(item.id, i, change));
    case "mcpToolCall":
      return [{ id: item.id, name: `mcp__${item.server}__${item.tool}`, kind: "mcp", input: { server: item.server, tool: item.tool }, args: asArgs(item.arguments) }];
    case "dynamicToolCall": {
      const args = asArgs(item.arguments);
      const input = piToolInput(item.tool, args);
      return [{ id: item.id, name: item.tool, kind: piToolKind(item.tool), ...withInput(input), args }];
    }
    case "webSearch": {
      const action = item.action;
      const url = action && (action.type === "openPage" || action.type === "findInPage") ? (action.url ?? undefined) : undefined;
      const query = str(item.query) ?? (action?.type === "search" ? (action.query ?? action.queries?.[0]) : undefined) ?? undefined;
      return [{ id: item.id, name: "web_search", kind: "web", ...withInput(compact(url ? { url } : { query })), args: { query: item.query, ...(action ? { action } : {}) } }];
    }
    case "imageView":
      return [{ id: item.id, name: "view_image", kind: "read", input: { path: item.path }, args: { path: item.path } }];
    case "collabAgentToolCall": {
      const description = item.prompt?.split("\n").map((l) => l.trim()).find(Boolean);
      return [{ id: item.id, name: item.tool, kind: "task", ...withInput(compact({ description })), args: { tool: item.tool, prompt: item.prompt } }];
    }
    case "subAgentActivity":
      // Only its start is a card; the session says when it finishes (with its last message).
      if (item.kind !== "started") return [];
      return [{ id: item.id, name: "spawn_agent", kind: "task", input: { description: `Codex sub-agent ${item.agentPath}` }, args: { agentPath: item.agentPath, agentThreadId: item.agentThreadId } }];
    default:
      return [];
  }
}

function withInput(input: ToolInput | undefined): { input?: ToolInput } {
  return input ? { input } : {};
}

export function toolBlock(call: CodexToolCall): ToolCallBlock {
  return { type: "toolCall", id: call.id, name: call.name, kind: call.kind, ...(call.input ? { input: call.input } : {}), args: call.args };
}

/**
 * A Codex file diff → `DiffLine`s: unified hunks (`@@ -a,b +c,d @@`), or a whole file for an added
 * (all `add`) or deleted (all `del`) file without hunks.
 */
export function codexDiff(change: FileUpdateChange): DiffLine[] | undefined {
  const text = change.diff ?? "";
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (!/^@@ /m.test(text)) {
    if (change.kind.type === "add") return lines.length ? lines.map((t, i) => ({ type: "add", text: t, newLine: i + 1 })) : undefined;
    if (change.kind.type === "delete") return lines.length ? lines.map((t, i) => ({ type: "del", text: t, oldLine: i + 1 })) : undefined;
    return undefined;
  }
  const out: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let hunks = 0;
  for (const raw of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      if (hunks++ > 0 || oldLine > 1) out.push({ type: "gap", text: "" });
      continue;
    }
    if (!hunks || raw.startsWith("\\") || raw.startsWith("---") || raw.startsWith("+++")) continue;
    const sign = raw[0];
    const body = raw.slice(1);
    if (sign === "+") out.push({ type: "add", text: body, newLine: newLine++ });
    else if (sign === "-") out.push({ type: "del", text: body, oldLine: oldLine++ });
    else out.push({ type: "context", text: body, oldLine: oldLine++, newLine: newLine++ });
  }
  return out.some((l) => l.type !== "gap") ? out : undefined;
}

/** Text of an MCP result's content blocks. */
export function mcpResultText(content: readonly JsonValue[] | undefined): string {
  return (content ?? [])
    .map((c) => (c && typeof c === "object" && !Array.isArray(c) && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** One line for a permission card about an item (the command or the files). */
export function itemSummary(item: ThreadItem | undefined): string[] {
  if (!item) return [];
  if (item.type === "fileChange") return item.changes.map((c) => c.path);
  if (item.type === "commandExecution") return [`$ ${displayCommand(item.command)}`];
  return [];
}
