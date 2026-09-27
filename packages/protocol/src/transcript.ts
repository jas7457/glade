/**
 * Harness-agnostic transcript model.
 *
 * Every harness adapter translates its native messages into these shapes, so the UI never
 * depends on a specific agent's wire format.
 */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  text: string;
  /** True when the provider hid the reasoning (only a signature/redacted marker exists). */
  redacted?: boolean;
}

/**
 * What a tool call does, independent of the harness's tool names (I-068). Adapters map their
 * native tools to a kind; the UI renders by kind. Anything without a canonical shape is `other`
 * and is shown from the raw `name`/`args`.
 */
export type ToolKind =
  | "shell" // run a shell command
  | "read" // read a file
  | "write" // create/overwrite a file
  | "edit" // replace text in a file
  | "search" // search file contents or names (grep / glob)
  | "list" // list a folder
  | "web" // fetch a URL or search the web
  | "task" // delegate to a sub-agent
  | "other";

export const TOOL_KINDS: readonly ToolKind[] = ["shell", "read", "write", "edit", "search", "list", "web", "task", "other"];

/** One exact-text replacement of an `edit` call. */
export interface ToolEdit {
  oldText: string;
  newText: string;
}

/**
 * Harness-neutral tool input, filled by the adapter. A flat optional set rather than a union
 * per kind, because it is also sent partially while a call streams (only what's known so far).
 */
export interface ToolInput {
  /** shell: the command line. */
  command?: string;
  /** read/write/edit: the file; search/list: the folder searched/listed. As given by the agent. */
  path?: string;
  /** read: first line to read (1-based). */
  offset?: number;
  /** read: number of lines to read. */
  limit?: number;
  /** write: the full new file content. */
  content?: string;
  /** edit: the replacements, in order. */
  edits?: ToolEdit[];
  /** search: the regex / glob searched for. */
  pattern?: string;
  /** search: file filter (glob) restricting a content search. */
  glob?: string;
  /** web: the URL fetched. */
  url?: string;
  /** web: the search query. */
  query?: string;
  /** task: what the sub-agent was asked to do (short); shell: optional description. */
  description?: string;
}

export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  /** The harness's own tool name (shown for `other`, never switched on by the UI). */
  name: string;
  /** Canonical kind, known from the name as soon as the call starts streaming. */
  kind: ToolKind;
  /**
   * Normalized input. While streaming it holds what the adapter could parse so far (summary
   * fields only); complete once `args` is set. Absent for `other` tools.
   */
  input?: ToolInput;
  /** Raw arguments (harness shape). `undefined` while the call is still streaming. */
  args: Record<string, unknown> | undefined;
  /** Raw argument text accumulated while streaming (before `args` is known). */
  argsText?: string;
}

export interface ImageBlock {
  type: "image";
  mimeType: string;
  /** Base64 data. */
  data: string;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ImageBlock;

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface UserMessage {
  id: string;
  role: "user";
  content: Array<TextBlock | ImageBlock>;
  timestamp: number;
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface AssistantMessage {
  id: string;
  role: "assistant";
  content: ContentBlock[];
  timestamp: number;
  model?: string;
  provider?: string;
  stopReason?: StopReason;
  /** Human readable error (e.g. the provider's message extracted from its JSON body). */
  errorMessage?: string;
  /** Raw error text as reported by the provider/harness, for a "Details" disclosure. */
  errorDetails?: string;
  usage?: Usage;
  /** True while the message is still being streamed. */
  streaming?: boolean;
}

/** Non-conversational entries worth showing inline (compaction, extension notes...). */
export interface NoticeMessage {
  id: string;
  role: "notice";
  kind: "info" | "warning" | "error" | "compaction";
  text: string;
  timestamp: number;
}

/** How a shell command the user ran (`!cmd` / `!!cmd`, I-076) ended. */
export interface ShellResult {
  /** Final output (the harness may truncate it; see `truncated`). */
  output: string;
  /** `null` when unknown (killed, cancelled, or it never ran). */
  exitCode: number | null;
  /** Stopped by the user. */
  cancelled: boolean;
  /** The output was cut; the full text may be in `fullOutputPath`. */
  truncated: boolean;
  fullOutputPath?: string;
  /** The command couldn't be run at all (harness error). */
  error?: string;
}

/**
 * A shell command the user ran in the chat's folder from the composer (I-076): `!cmd` shares the
 * output with the agent (it sees it with the next prompt), `!!cmd` doesn't.
 */
export interface ShellMessage extends ShellResult {
  id: string;
  role: "shell";
  command: string;
  /** The agent sees the command and its output (with the next prompt). */
  shared: boolean;
  /** Still running (output streams into `output`). */
  running: boolean;
  /** When it started (epoch ms; for history, when it was recorded). */
  timestamp: number;
  /** When it finished (epoch ms), if known. */
  endedAt?: number;
}

export type ChatMessage = UserMessage | AssistantMessage | NoticeMessage | ShellMessage;

export type ToolStatus = "running" | "done" | "error";

/** One line of a normalized diff; `gap` marks skipped unchanged lines. */
export interface DiffLine {
  type: "add" | "del" | "context" | "gap";
  text: string;
  /** Line number in the old file (del/context lines, when known). */
  oldLine?: number;
  /** Line number in the new file (add/context lines, when known). */
  newLine?: number;
}

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  status: ToolStatus;
  /** Text output (accumulated while running, final once done). */
  output: string;
  images?: ImageBlock[];
  /** The change a file tool made, when the harness reports one (normalized by the adapter). */
  diff?: DiffLine[];
  /** Harness specific structured details (raw; the UI doesn't interpret them). */
  details?: unknown;
  /** When the tool started / finished (epoch ms; I-070). Absent when unknown (e.g. old history). */
  startedAt?: number;
  endedAt?: number;
}

export interface Transcript {
  messages: ChatMessage[];
  /** Tool results keyed by tool call id. */
  toolResults: Record<string, ToolResult>;
}

export function emptyTranscript(): Transcript {
  return { messages: [], toolResults: {} };
}

/** Plain text of a message (text blocks only). */
export function messageText(message: ChatMessage): string {
  if (message.role === "notice") return message.text;
  if (message.role === "shell") return `$ ${message.command}\n${message.output}`;
  const blocks: ContentBlock[] = message.content;
  return blocks
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
}
