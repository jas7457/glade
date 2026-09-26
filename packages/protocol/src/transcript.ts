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

export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  /** Parsed arguments. `undefined` while the call is still streaming. */
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
  errorMessage?: string;
  usage?: Usage;
  /** True while the message is still being streamed. */
  streaming?: boolean;
}

/** Non-conversational entries worth showing inline (compaction, bash, extension notes...). */
export interface NoticeMessage {
  id: string;
  role: "notice";
  kind: "info" | "warning" | "error" | "compaction" | "bash";
  text: string;
  timestamp: number;
}

export type ChatMessage = UserMessage | AssistantMessage | NoticeMessage;

export type ToolStatus = "running" | "done" | "error";

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  status: ToolStatus;
  /** Text output (accumulated while running, final once done). */
  output: string;
  images?: ImageBlock[];
  /** Harness specific structured details (e.g. diffs). Renderers may use it opportunistically. */
  details?: unknown;
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
  const blocks: ContentBlock[] = message.content;
  return blocks
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
}
