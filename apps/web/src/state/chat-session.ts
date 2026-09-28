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
  type MessagePatch,
  type SessionDetail,
  type SessionLiveState,
  type SessionSummary,
  type SessionState,
  type SlashCommand,
  type ToolResult,
  type Transcript,
  type TranscriptPage,
  type UiRequest,
} from "@glade/protocol";
import { api, type ApiClient } from "@/lib/api";
import { socket } from "@/lib/socket";
import { notify } from "./toasts";

/**
 * Where a session's requests and "on screen" reports go (I-123: its environment's client and
 * socket). `state/environments.ts` installs the real resolver; the default is the local server.
 */
export interface ChatEnvironmentResolver {
  api(sessionId: string): ApiClient;
  watch(sessionId: string): () => void;
}

let resolver: ChatEnvironmentResolver = { api: () => api, watch: (id) => socket.watch(id) };

export function setChatEnvironmentResolver(next: ChatEnvironmentResolver): void {
  resolver = next;
}

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
  /**
   * The last load was an offline snapshot (`SessionDetail.offline`: another server held the
   * session, or a closed sub-agent): partial state, reloaded when the session changes (I-102).
   */
  offline: boolean;
  /**
   * Index of the first loaded message in the whole transcript (I-122): a sync snapshot holds only
   * the newest turns; `loadEarlierMessages` loads the rest. 0 = everything is loaded.
   */
  start: Signal<number>;
  loadingEarlier: Signal<boolean>;
}

/**
 * Sequenced sync of open chats (I-122, `state/sync.ts` registers these at startup; no-ops in tests
 * and before it): a mounted chat is subscribed, and a loaded detail is the point to replay from.
 */
export interface ChatSyncHooks {
  retain(sessionId: string): () => void;
  /** A detail was loaded over HTTP: everything up to `seq` is in it (`null`: unknown). */
  seed(sessionId: string, seq: number | null): void;
  /** Subscribe from scratch (a patch didn't fit). */
  restart(sessionId: string): void;
}

let syncHooks: ChatSyncHooks = { retain: () => () => {}, seed: () => {}, restart: () => {} };

export function setChatSyncHooks(hooks: ChatSyncHooks): void {
  syncHooks = hooks;
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
      offline: false,
      start: signal(0),
      loadingEarlier: signal(false),
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
  store.offline = detail.offline === true;
  store.start.value = 0;
  store.status.value = "ready";
  store.error.value = null;
  syncHooks.seed(detail.session.id, detail.seq ?? null);
  return store;
}

/** A sync snapshot (I-122): the newest turns of the transcript and the live state. */
export function applySessionSnapshot(sessionId: string, page: TranscriptPage, live: SessionLiveState): void {
  const store = getChatSession(sessionId);
  store.transcript.value = { messages: page.messages, toolResults: page.toolResults };
  store.start.value = page.start;
  applySessionLive(sessionId, live);
}

/** Caught up (I-122): the live state that isn't in the event log. */
export function applySessionLive(sessionId: string, live: SessionLiveState): void {
  const store = getChatSession(sessionId);
  store.state.value = live.state;
  store.uiRequests.value = live.pendingUiRequests;
  store.offline = live.offline === true;
  store.status.value = "ready";
  store.error.value = null;
}

/** Subscribing failed (e.g. the chat's agent isn't installed here). */
export function applySessionError(sessionId: string, error: string): void {
  const store = getChatSession(sessionId);
  if (store.status.value === "ready") return;
  store.status.value = "error";
  store.error.value = error;
}

/**
 * Changed messages from the event log (I-122), at their index in the whole transcript. Returns
 * false when they don't fit what's loaded (the caller subscribes from scratch).
 */
export function applyTranscriptPatch(sessionId: string, patches: MessagePatch[], toolResults: ToolResult[]): boolean {
  const store = sessions.get(sessionId);
  if (!store || store.status.value !== "ready") return true;
  const start = store.start.value;
  const current = store.transcript.value;
  let messages = current.messages;
  for (const { index, message } of patches) {
    const at = messages.findIndex((m) => m.id === message.id);
    if (at !== -1) {
      if (messages === current.messages) messages = messages.slice();
      messages[at] = message;
      continue;
    }
    const local = index - start;
    if (local < 0) continue; // before the loaded page
    if (local > messages.length) return false;
    messages = [...messages.slice(0, local), message, ...messages.slice(local)];
  }
  const results = toolResults.length ? { ...current.toolResults, ...Object.fromEntries(toolResults.map((r) => [r.toolCallId, r])) } : current.toolResults;
  if (messages !== current.messages || results !== current.toolResults) store.transcript.value = { messages, toolResults: results };
  return true;
}

/** Load the turns before the first loaded message (I-122 "load earlier"). */
export async function loadEarlierMessages(sessionId: string, turns = 50): Promise<void> {
  const store = getChatSession(sessionId);
  if (store.start.value === 0 || store.loadingEarlier.value) return;
  store.loadingEarlier.value = true;
  try {
    const page = await resolver.api(sessionId).getTranscriptPage(sessionId, store.start.value, turns);
    const current = store.transcript.value;
    const known = new Set(current.messages.map((m) => m.id));
    store.transcript.value = {
      messages: [...page.messages.filter((m) => !known.has(m.id)), ...current.messages],
      toolResults: { ...page.toolResults, ...current.toolResults },
    };
    store.start.value = page.start;
  } catch (err) {
    notify("error", `Could not load earlier messages: ${(err as Error).message}`);
  } finally {
    store.loadingEarlier.value = false;
  }
}

export async function loadChatSession(sessionId: string): Promise<void> {
  const store = getChatSession(sessionId);
  if (store.status.value === "loading") return;
  store.status.value = "loading";
  try {
    applySessionDetail(await resolver.api(sessionId).getSession(sessionId));
  } catch (err) {
    store.status.value = "error";
    store.error.value = (err as Error).message;
    // The sync subscription (I-122) retries with a snapshot once the server is back.
    syncHooks.seed(sessionId, null);
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
      .then(() => resolver.api(sessionId).listCommands(sessionId))
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

/**
 * After a reconnect: reload loaded chats, and retry ones that failed while the server was away.
 * `which`: only the chats of one environment (I-123).
 */
export async function reloadOpenChatSessions(which: (sessionId: string) => boolean = () => true): Promise<void> {
  const stale = [...sessions.values()].filter((s) => (s.status.value === "ready" || s.status.value === "error") && which(s.sessionId));
  await Promise.all(stale.map((s) => loadChatSession(s.sessionId)));
}

/**
 * I-062: a session another Glade server runs isn't streamed here; reload its transcript (read from
 * the session file) when it starts or stops running there, or when it ran there meanwhile.
 */
export function reloadIfChangedElsewhere(previous: SessionSummary | undefined, next: SessionSummary): void {
  const store = sessions.get(next.id);
  if (store?.status.value !== "ready") return;
  const was = previous?.activeElsewhere;
  const now = next.activeElsewhere;
  const changed =
    (!!previous && (!!was !== !!now || (!!now && (previous.lastActivityAt !== next.lastActivityAt || previous.status !== next.status)))) ||
    // I-102: an offline snapshot (e.g. loaded while another server still held the session, as
    // during a server restart) lacks thinking levels and context usage. The server pushes the
    // session when its lease changes; load it again then, unless it's busy elsewhere.
    (store.offline && !now);
  if (changed) void loadChatSession(next.id);
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
    const release = syncHooks.retain(sessionId);
    const unwatch = markViewing ? resolver.watch(sessionId) : null;
    return () => {
      release();
      unwatch?.();
    };
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
