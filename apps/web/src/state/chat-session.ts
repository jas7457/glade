/**
 * Per-session live state: transcript, agent session state and pending dialogs. Keyed by
 * **session id** (I-035: a workspace = sidebar row holds one or more sessions; each session is one
 * agent conversation). The "chat" names are kept because the transcript/composer still call a
 * conversation a chat.
 *
 * Any component can call `useChatSession(sessionId)` (or `getChatSession`) to get the same store,
 * which is what lets the transcript and composer be reused in multiple places (tabs, panes).
 */
import { signal, type Signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import {
  applyAgentEvent,
  defaultSessionState,
  emptyTranscript,
  type AgentEvent,
  type SessionDetail,
  type SessionSummary,
  type SessionState,
  type SlashCommand,
  type Transcript,
  type UiRequest,
} from "@glade/protocol";
import { api } from "@/lib/api";
import { socket } from "@/lib/socket";
import { notify } from "./toasts";

export interface ChatSessionStore {
  sessionId: string;
  transcript: Signal<Transcript>;
  state: Signal<SessionState>;
  uiRequests: Signal<UiRequest[]>;
  status: Signal<"idle" | "loading" | "ready" | "error">;
  error: Signal<string | null>;
  /** Last error reported by the agent itself (process crash etc). */
  agentError: Signal<string | null>;
  /** The harness's slash commands for this session; `null` until loaded (see loadChatCommands). */
  commands: Signal<SlashCommand[] | null>;
}

const sessions = new Map<string, ChatSessionStore>();

export function getChatSession(sessionId: string): ChatSessionStore {
  let store = sessions.get(sessionId);
  if (!store) {
    store = {
      sessionId,
      transcript: signal(emptyTranscript()),
      state: signal(defaultSessionState()),
      uiRequests: signal([]),
      status: signal("idle"),
      error: signal(null),
      agentError: signal(null),
      commands: signal(null),
    };
    sessions.set(sessionId, store);
  }
  return store;
}

/** Seed a store from a server response (e.g. right after creating a workspace or tab). */
export function applySessionDetail(detail: SessionDetail): ChatSessionStore {
  const store = getChatSession(detail.session.id);
  store.transcript.value = detail.transcript;
  store.state.value = detail.state;
  store.uiRequests.value = detail.pendingUiRequests;
  store.status.value = "ready";
  store.error.value = null;
  return store;
}

export async function loadChatSession(sessionId: string): Promise<void> {
  const store = getChatSession(sessionId);
  if (store.status.value === "loading") return;
  store.status.value = "loading";
  try {
    applySessionDetail(await api.getSession(sessionId));
  } catch (err) {
    store.status.value = "error";
    store.error.value = (err as Error).message;
  }
}

const commandLoads = new Map<string, Promise<void>>();

/** Fetch the session's harness slash commands once (they're fixed for the agent's lifetime). */
export function loadChatCommands(sessionId: string): Promise<void> {
  const store = getChatSession(sessionId);
  if (store.commands.value) return Promise.resolve();
  let pending = commandLoads.get(sessionId);
  if (!pending) {
    pending = Promise.resolve()
      .then(() => api.listCommands(sessionId))
      .then((commands) => {
        store.commands.value = commands;
      })
      .catch(() => {
        // Not fatal: the menu still shows Glade's built-ins. Retried on the next open.
      })
      .finally(() => commandLoads.delete(sessionId));
    commandLoads.set(sessionId, pending);
  }
  return pending;
}

export async function reloadOpenChatSessions(): Promise<void> {
  await Promise.all([...sessions.values()].filter((s) => s.status.value === "ready").map((s) => loadChatSession(s.sessionId)));
}

/**
 * I-062: a session another Glade server runs isn't streamed here; reload its transcript (read from
 * the session file) when it starts or stops running there, or when it ran there meanwhile.
 */
export function reloadIfChangedElsewhere(previous: SessionSummary | undefined, next: SessionSummary): void {
  if (!previous) return;
  const was = previous.activeElsewhere;
  const now = next.activeElsewhere;
  const changed = !!was !== !!now || (!!now && (previous.lastActivityAt !== next.lastActivityAt || previous.status !== next.status));
  if (!changed) return;
  const store = sessions.get(next.id);
  if (store?.status.value === "ready") void loadChatSession(next.id);
}

export function handleSessionEvent(sessionId: string, event: AgentEvent): void {
  const store = sessions.get(sessionId);
  if (event.type === "notify") notify(event.level, event.message);
  if (!store || store.status.value !== "ready") return;
  store.transcript.value = applyAgentEvent(store.transcript.value, event);
  switch (event.type) {
    case "state":
      store.state.value = { ...store.state.value, ...event.state };
      break;
    case "run_start":
      store.agentError.value = null;
      store.state.value = { ...store.state.value, runStartedAt: event.at ?? Date.now() };
      break;
    case "ui_request":
      store.uiRequests.value = [...store.uiRequests.value.filter((r) => r.id !== event.request.id), event.request];
      break;
    case "ui_request_closed":
      store.uiRequests.value = store.uiRequests.value.filter((r) => r.id !== event.id);
      break;
    case "run_end":
      store.uiRequests.value = [];
      store.state.value = { ...store.state.value, runStartedAt: null };
      break;
    case "error":
      store.agentError.value = event.message;
      break;
  }
}

/**
 * Hook: get the session store, load it if needed, and tell the server this session is on screen
 * (so finished runs don't get marked unread) while the component is mounted.
 */
export function useChatSession(sessionId: string, { markViewing = true } = {}): ChatSessionStore {
  const store = getChatSession(sessionId);
  useEffect(() => {
    if (store.status.value === "idle" || store.status.value === "error") void loadChatSession(sessionId);
    if (!markViewing) return;
    return socket.watch(sessionId);
  }, [sessionId, markViewing]);
  return store;
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

export async function runAction(fn: () => Promise<unknown>, errorPrefix: string): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    notify("error", `${errorPrefix}: ${(err as Error).message}`);
    return false;
  }
}

/** For tests. */
export function resetChatSessions(): void {
  sessions.clear();
  commandLoads.clear();
}
