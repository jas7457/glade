/**
 * Global app state (Preact signals). Server pushes keep these in sync; components read the
 * signals directly and call the actions below.
 */
import { computed, signal } from "@preact/signals";
import {
  defaultSettings,
  type ChatSummary,
  type ModelInfo,
  type Project,
  type ServerMessage,
  type Settings,
} from "@pi-ui/protocol";
import { api } from "@/lib/api";
import { socket } from "@/lib/socket";
import { handleChatEvent, reloadOpenChatSessions } from "./chat-session";
import { notify } from "./toasts";
import { handleUsageMessage } from "./usage";

export const projects = signal<Project[]>([]);
export const chats = signal<ChatSummary[]>([]);
export const models = signal<ModelInfo[]>([]);
export const settings = signal<Settings>(defaultSettings());
export const initialized = signal(false);
export const initError = signal<string | null>(null);

/** Models shown in pickers (hidden ones filtered out). */
export const visibleModels = computed(() => {
  const hidden = new Set(settings.value.models.hiddenModels);
  return models.value.filter((m) => !hidden.has(`${m.provider}/${m.id}`));
});

export const projectsById = computed(() => new Map(projects.value.map((p) => [p.id, p])));
export const chatsById = computed(() => new Map(chats.value.map((c) => [c.id, c])));

/** Sidebar ordering: pinned first, then most recent activity. */
export const sortedProjects = computed(() =>
  [...projects.value].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivityAt - a.lastActivityAt),
);

export function chatsForProject(projectId: string | null): ChatSummary[] {
  return chats.value
    .filter((c) => c.projectId === projectId)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivityAt - a.lastActivityAt);
}

// ---------------------------------------------------------------------------------------------
// Loading + server push
// ---------------------------------------------------------------------------------------------

export async function loadAll(): Promise<void> {
  try {
    const [p, c, s] = await Promise.all([api.listProjects(), api.listChats(), api.getSettings()]);
    projects.value = p;
    chats.value = c;
    settings.value = s;
    initError.value = null;
  } catch (err) {
    initError.value = (err as Error).message;
  } finally {
    initialized.value = true;
  }
  // Models can be slow (spawns the agent); don't block the UI on them.
  void loadModels();
}

export async function loadModels(refresh = false): Promise<void> {
  try {
    models.value = await api.listModels(refresh);
  } catch (err) {
    notify("error", `Could not load models: ${(err as Error).message}`);
  }
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...list, item];
  const copy = list.slice();
  copy[idx] = item;
  return copy;
}

export function handleServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case "chat_upsert":
      chats.value = upsert(chats.value, message.chat);
      break;
    case "chat_removed":
      chats.value = chats.value.filter((c) => c.id !== message.chatId);
      break;
    case "project_upsert":
      projects.value = upsert(projects.value, message.project);
      break;
    case "project_removed":
      projects.value = projects.value.filter((p) => p.id !== message.projectId);
      break;
    case "settings":
      settings.value = message.settings;
      break;
    case "models":
      models.value = message.models;
      break;
    case "chat_event":
      handleChatEvent(message.chatId, message.event);
      break;
    case "usage_limits":
      handleUsageMessage(message.usage);
      break;
    case "hello":
      break;
  }
}

let started = false;

/** Connect the socket and load initial data. Call once at startup. */
export function startSync(): void {
  if (started) return;
  started = true;
  socket.onMessage(handleServerMessage);
  socket.onReconnect(() => {
    void loadAll();
    void reloadOpenChatSessions();
  });
  socket.connect();
  void loadAll();
}
