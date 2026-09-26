/**
 * Chat attention status, shown in the sidebar, the window title and the Dock badge.
 *
 * Precedence (highest first):
 *   blocked  – the agent is paused waiting for the user (an extension dialog: confirm/select/input/editor).
 *              Deterministic: pi only pauses on these explicit requests. A model asking a question in
 *              plain text ends the run instead, which surfaces as `unread`.
 *   working  – the agent is running and hasn't finished.
 *   unread   – a run finished (or failed) while the chat wasn't on screen.
 *   idle     – nothing new; waiting on the user.
 *
 * `lastRunFailed` is an orthogonal flag: the most recent run ended in an error/crash, so `unread`
 * and `idle` can be rendered in an error style.
 */
export type ChatStatus = "idle" | "unread" | "working" | "blocked";

/** Same thing, per session (I-035). Workspaces roll it up with `aggregateChatStatus`. */
export type SessionStatus = ChatStatus;

export const CHAT_STATUS_PRIORITY: Record<ChatStatus, number> = {
  idle: 0,
  unread: 1,
  working: 2,
  blocked: 3,
};

export interface ChatStatusInputs {
  running: boolean;
  /** Number of open agent dialogs waiting for an answer. */
  pendingInputs: number;
  unread: boolean;
}

export function deriveChatStatus({ running, pendingInputs, unread }: ChatStatusInputs): ChatStatus {
  if (pendingInputs > 0) return "blocked";
  if (running) return "working";
  if (unread) return "unread";
  return "idle";
}

/** The most urgent status in a set (e.g. for a collapsed project row or the app badge). */
export function aggregateChatStatus(statuses: Iterable<ChatStatus>): ChatStatus {
  let best: ChatStatus = "idle";
  for (const s of statuses) if (CHAT_STATUS_PRIORITY[s] > CHAT_STATUS_PRIORITY[best]) best = s;
  return best;
}

/** Statuses that need the user's attention (count towards badges). */
export function needsAttention(status: ChatStatus): boolean {
  return status === "unread" || status === "blocked";
}
