/**
 * Sequenced live sync (I-122): the WebSocket protocol version 2 and the client's duplicate/gap
 * rule, shared by the server and the web app.
 *
 * Every change a client can see is committed to the server's event log with a global sequence
 * number (`seq`). A client subscribes per scope: `shell` (projects, workspaces, sessions,
 * settings, agents) and one `session` scope per open chat (its transcript). The server replays
 * the events after the client's `afterSeq`, or sends a `snapshot` when the gap is too big, the
 * events were pruned or `afterSeq` is missing, then `live`. Pushes are batched (`batch`).
 *
 * Tags on a push (per scope):
 * - **committed** (`seq` and `prev`): a change from the event log. `prev` is the seq of the
 *   previous committed push the server sent this client in this scope. `seq <= last` is a
 *   duplicate (dropped); `prev > last` means something was missed (re-subscribe from `last`).
 * - **ephemeral** (`seq` only): live-only state based on `seq` (streaming deltas, run state,
 *   dialogs, derived status). Applied when `seq === last`; `seq < last` is stale (dropped:
 *   the replay or snapshot the client already has includes it); `seq > last` is a gap.
 * - `snapshot` and `live` reset `last` to their `seq`.
 * - Untagged pushes (no `seq`) are applied as they come (actions like `open_chat`).
 */
import type { SessionState, UiRequest } from "./events.js";
import type { ChatMessage, ToolResult } from "./transcript.js";

/** WebSocket protocol version with sequenced sync (announced in `hello.protocol`). */
export const SYNC_PROTOCOL = 2;

/** Client header (or `commandId` body field) that makes a mutating request idempotent. */
export const COMMAND_ID_HEADER = "x-glade-command-id";

export type SyncScope = "shell" | "session";

export interface SyncTag {
  seq?: number;
  prev?: number;
}

/** A page of a transcript, by turn (a turn starts with a user message). */
export interface TranscriptPage {
  messages: ChatMessage[];
  /** Results of the tool calls in `messages`. */
  toolResults: Record<string, ToolResult>;
  /** Index of the first message in the whole transcript (0 = nothing earlier). */
  start: number;
  /** Number of messages in the whole transcript. */
  total: number;
}

/** One changed message and its index in the whole transcript. */
export interface MessagePatch {
  index: number;
  message: ChatMessage;
}

/** Live state that isn't in the event log, sent with a session scope's `snapshot` and `live`. */
export interface SessionLiveState {
  state: SessionState;
  pendingUiRequests: UiRequest[];
  /** Not running in this server (another server holds it, or a closed sub-agent): partial state. */
  offline?: boolean;
}

export type ClientSyncMessage =
  | { type: "subscribe"; scope: "shell"; afterSeq?: number }
  | { type: "subscribe"; scope: "session"; sessionId: string; afterSeq?: number }
  | { type: "unsubscribe"; scope: "session"; sessionId: string }
  | { type: "ping"; t: number }
  | { type: "pong"; t: number };

/**
 * What a client does with a tagged push, given the last seq it has in that scope (`null` = not
 * caught up yet: only `snapshot` / `live` count then).
 */
export type SyncVerdict = "apply" | "drop" | "gap";

export function classifySeq(last: number | null, tag: SyncTag): SyncVerdict {
  if (tag.seq === undefined) return "apply";
  if (last === null) return "drop";
  if (tag.prev !== undefined) {
    if (tag.seq <= last) return "drop";
    if (tag.prev > last) return "gap";
    return "apply";
  }
  if (tag.seq < last) return "drop";
  if (tag.seq > last) return "gap";
  return "apply";
}

/** Index of the first message of the newest `turns` turns in `messages[0..end)`. */
export function turnPageStart(messages: ReadonlyArray<Pick<ChatMessage, "role">>, end: number, turns: number): number {
  let seen = 0;
  for (let i = Math.min(end, messages.length) - 1; i >= 0; i--) {
    if (messages[i]!.role === "user" && ++seen >= turns) return i;
  }
  return 0;
}

/** Tool call ids in a list of messages. */
export function toolCallIdsOf(messages: readonly ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const block of m.content) if (block.type === "toolCall") ids.add(block.id);
  }
  return ids;
}
