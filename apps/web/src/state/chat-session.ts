/**
 * Per-chat live state: transcript, agent session state and pending dialogs.
 *
 * Any component can call `useChatSession(chatId)` (or `getChatSession`) to get the same store,
 * which is what lets the transcript and composer be reused in multiple places.
 */
import { signal, type Signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import {
  applyAgentEvent,
  defaultSessionState,
  emptyTranscript,
  type AgentEvent,
  type ChatDetail,
  type SessionState,
  type SlashCommand,
  type Transcript,
  type UiRequest,
} from "@pi-ui/protocol";
import { api } from "@/lib/api";
import { socket } from "@/lib/socket";
import { notify } from "./toasts";

export interface ChatSessionStore {
  chatId: string;
  transcript: Signal<Transcript>;
  state: Signal<SessionState>;
  uiRequests: Signal<UiRequest[]>;
  status: Signal<"idle" | "loading" | "ready" | "error">;
  error: Signal<string | null>;
  /** Last error reported by the agent itself (process crash etc). */
  agentError: Signal<string | null>;
  /** The harness's slash commands for this chat; `null` until loaded (see loadChatCommands). */
  commands: Signal<SlashCommand[] | null>;
}

const sessions = new Map<string, ChatSessionStore>();

export function getChatSession(chatId: string): ChatSessionStore {
  let store = sessions.get(chatId);
  if (!store) {
    store = {
      chatId,
      transcript: signal(emptyTranscript()),
      state: signal(defaultSessionState()),
      uiRequests: signal([]),
      status: signal("idle"),
      error: signal(null),
      agentError: signal(null),
      commands: signal(null),
    };
    sessions.set(chatId, store);
  }
  return store;
}

/** Seed a store from a server response (e.g. right after creating a chat). */
export function applyChatDetail(detail: ChatDetail): ChatSessionStore {
  const store = getChatSession(detail.chat.id);
  store.transcript.value = detail.transcript;
  store.state.value = detail.state;
  store.uiRequests.value = detail.pendingUiRequests;
  store.status.value = "ready";
  store.error.value = null;
  return store;
}

export async function loadChatSession(chatId: string): Promise<void> {
  const store = getChatSession(chatId);
  if (store.status.value === "loading") return;
  store.status.value = "loading";
  try {
    applyChatDetail(await api.getChat(chatId));
  } catch (err) {
    store.status.value = "error";
    store.error.value = (err as Error).message;
  }
}

const commandLoads = new Map<string, Promise<void>>();

/** Fetch the chat's harness slash commands once (they're fixed for the agent's lifetime). */
export function loadChatCommands(chatId: string): Promise<void> {
  const store = getChatSession(chatId);
  if (store.commands.value) return Promise.resolve();
  let pending = commandLoads.get(chatId);
  if (!pending) {
    pending = Promise.resolve()
      .then(() => api.listCommands(chatId))
      .then((commands) => {
        store.commands.value = commands;
      })
      .catch(() => {
        // Not fatal: the menu still shows pi-ui's built-ins. Retried on the next open.
      })
      .finally(() => commandLoads.delete(chatId));
    commandLoads.set(chatId, pending);
  }
  return pending;
}

export async function reloadOpenChatSessions(): Promise<void> {
  await Promise.all([...sessions.values()].filter((s) => s.status.value === "ready").map((s) => loadChatSession(s.chatId)));
}

export function handleChatEvent(chatId: string, event: AgentEvent): void {
  const store = sessions.get(chatId);
  if (event.type === "notify") notify(event.level, event.message);
  if (!store || store.status.value !== "ready") return;
  store.transcript.value = applyAgentEvent(store.transcript.value, event);
  switch (event.type) {
    case "state":
      store.state.value = { ...store.state.value, ...event.state };
      break;
    case "run_start":
      store.agentError.value = null;
      break;
    case "ui_request":
      store.uiRequests.value = [...store.uiRequests.value.filter((r) => r.id !== event.request.id), event.request];
      break;
    case "ui_request_closed":
      store.uiRequests.value = store.uiRequests.value.filter((r) => r.id !== event.id);
      break;
    case "run_end":
      store.uiRequests.value = [];
      break;
    case "error":
      store.agentError.value = event.message;
      break;
  }
}

/**
 * Hook: get the chat store, load it if needed, and tell the server this chat is on screen
 * (so finished runs don't get marked unread).
 */
export function useChatSession(chatId: string, { markViewing = true } = {}): ChatSessionStore {
  const store = getChatSession(chatId);
  useEffect(() => {
    if (store.status.value === "idle" || store.status.value === "error") void loadChatSession(chatId);
    if (!markViewing) return;
    socket.setViewing(chatId);
    return () => socket.setViewing(null);
  }, [chatId, markViewing]);
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
