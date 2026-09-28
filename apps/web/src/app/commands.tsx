/**
 * App command registry: every action the user can run by name (command palette), with its
 * shortcut. Global shortcuts and the desktop menu share the same implementations through
 * `globalCommands()` (ids = `SHORTCUTS` keys = menu item ids).
 *
 *   const commands = buildCommands({ navigate, route, openPalette });
 *   commands.filter(isAvailable).forEach((c) => …c.run());
 *
 * A command with `prompt` asks for text first (e.g. Rename Chat): the palette turns its search
 * field into that input and calls the prompt's `submit` instead of `run`.
 */
import type { ComponentChildren } from "preact";
import type { Settings, WorkspaceSummary } from "@glade/protocol";
import { needsAttention } from "@glade/protocol";
import {
  Folder,
  FolderPlus,
  Mail,
  MailOpen,
  Monitor,
  Moon,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  Sparkles,
  SquarePen,
  Sun,
  Trash2,
  X,
} from "lucide-preact";
import { StatusIndicator } from "@/ui";
import { confirmDeleteChat } from "@/features/sidebar/delete-chat";
import { loadModels, sortedProjects as orderedProjects, projectsById, resolveSessionId, sessionsById, workspaces, workspacesById } from "@/state/store";
import { markSessionUnread, markWorkspaceRead, renameWorkspace, setWorkspacePinned, updateSettings } from "@/state/actions";
import { notify } from "@/state/toasts";
import { openAddProject, toggleSidebar } from "@/state/ui";
import { SECTION_INFO } from "@/features/settings/sections";
import { closeTab, openNewTab, renameWithAi } from "@/features/workspace";
import type { RouteContext } from "./paths";
import { SETTINGS_SECTIONS, chatPath, routes } from "./routes";
import { SHORTCUTS, TAB_SHORTCUTS, type GlobalCommandId, type ShortcutHandlers } from "./shortcuts";

export type CommandGroup = "Chats" | "Projects" | "Actions";
export const COMMAND_GROUPS: readonly CommandGroup[] = ["Chats", "Projects", "Actions"];

/** Text input requested by a command before it can finish. */
export interface CommandPrompt {
  title: string;
  placeholder?: string;
  initial: string;
  submit: (value: string) => void | Promise<unknown>;
}

export interface Command {
  id: string;
  title: string;
  group: CommandGroup;
  /** Muted text after the title (e.g. a chat's project). */
  subtitle?: string;
  /** Extra search words. */
  keywords?: readonly string[];
  /** `formatShortcut` key string, shown on the right. */
  shortcut?: string;
  icon?: ComponentChildren;
  /** Only listed while searching (keeps the empty palette short). */
  searchOnly?: boolean;
  /** Hidden when this returns false (e.g. chat actions without a current chat). */
  available?: () => boolean;
  run: () => void | Promise<unknown>;
  /** Ask for text before running; `null` = nothing to do. */
  prompt?: () => CommandPrompt | null;
}

export interface CommandContext {
  navigate: (path: string) => void;
  route: RouteContext;
  /** Toggle the command palette (⌘K). */
  togglePalette: () => void;
}

export const isAvailable = (c: Command) => c.available?.() ?? true;

/** The actions behind global shortcuts and desktop menu items. */
export function globalCommands(ctx: CommandContext): ShortcutHandlers {
  return {
    "new-chat": () => ctx.navigate(ctx.route.projectId ? routes.project(ctx.route.projectId) : routes.home(ctx.route.envId)),
    settings: () => ctx.navigate(routes.settings()),
    "toggle-sidebar": toggleSidebar,
    "command-palette": ctx.togglePalette,
  };
}

/** Chats for the palette: needing attention first, then most recent activity. */
export function paletteChatOrder(list: readonly WorkspaceSummary[]): WorkspaceSummary[] {
  return [...list].sort(
    (a, b) => Number(needsAttention(b.status)) - Number(needsAttention(a.status)) || b.lastActivityAt - a.lastActivityAt,
  );
}

const THEMES: { value: Settings["appearance"]["theme"]; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "Auto", Icon: Monitor },
];

export function buildCommands(ctx: CommandContext): Command[] {
  const { navigate, route } = ctx;
  const global = globalCommands(ctx);
  const current = () => (route.workspaceId ? workspacesById.value.get(route.workspaceId) : undefined);
  const hasChat = () => current() !== undefined;
  const sortedProjects = orderedProjects.value;
  const out: Command[] = [];

  for (const chat of paletteChatOrder(workspaces.value)) {
    out.push({
      id: `chat:${chat.id}`,
      title: chat.title || "Untitled",
      group: "Chats",
      subtitle: chat.projectId ? projectsById.value.get(chat.projectId)?.name : undefined,
      icon: <StatusIndicator status={chat.status} failed={chat.lastRunFailed} tooltip={false} />,
      run: () => navigate(chatPath(chat)),
    });
  }

  for (const project of sortedProjects) {
    out.push({
      id: `project:${project.id}`,
      title: project.name,
      group: "Projects",
      subtitle: project.path,
      icon: <Folder />,
      run: () => navigate(routes.project(project.id)),
    });
  }

  out.push(
    { id: "new-chat", title: "New Chat", group: "Actions", shortcut: SHORTCUTS["new-chat"], icon: <SquarePen />, run: global["new-chat"] },
    ...sortedProjects.map<Command>((project) => ({
      id: `new-chat-in:${project.id}`,
      title: `New Chat in ${project.name}`,
      group: "Actions",
      icon: <SquarePen />,
      searchOnly: true,
      run: () => navigate(routes.project(project.id)),
    })),
    { id: "add-project", title: "Add Project…", group: "Actions", keywords: ["folder", "open"], icon: <FolderPlus />, run: openAddProject },
    {
      id: "toggle-sidebar",
      title: "Toggle Sidebar",
      group: "Actions",
      keywords: ["hide", "show"],
      shortcut: SHORTCUTS["toggle-sidebar"],
      icon: <PanelLeft />,
      run: global["toggle-sidebar"],
    },
    {
      id: "new-tab",
      title: "New Tab",
      group: "Actions",
      keywords: ["session"],
      shortcut: TAB_SHORTCUTS["new-tab"],
      icon: <Plus />,
      available: hasChat,
      run: async () => {
        const chat = current();
        if (chat) await openNewTab(chat.id, (path) => navigate(path));
      },
    },
    {
      id: "close-tab",
      title: "Close Tab",
      group: "Actions",
      shortcut: TAB_SHORTCUTS["close-tab"],
      icon: <X />,
      // Closing the last main tab deletes the chat (closeTab asks first, I-061).
      available: hasChat,
      run: async () => {
        if (!route.workspaceId) return;
        const tab = new URLSearchParams(window.location.search).get("tab");
        const id = resolveSessionId(route.workspaceId, tab);
        const session = id ? sessionsById.value.get(id) : undefined;
        if (session) await closeTab(session, (path) => navigate(path), { focused: true });
      },
    },
    {
      id: "rename-chat",
      title: "Rename Chat…",
      group: "Actions",
      keywords: ["title"],
      icon: <Pencil />,
      available: hasChat,
      run: () => {},
      prompt: () => {
        const chat = current();
        if (!chat) return null;
        return {
          title: "Rename Chat",
          placeholder: "Chat title",
          initial: chat.title,
          submit: (title) => (title.trim() && title.trim() !== chat.title ? renameWorkspace(chat.id, title.trim()) : undefined),
        };
      },
    },
    {
      // I-101: the small model names the focused tab from its conversation (like `/name`).
      id: "rename-with-ai",
      title: "Rename with AI",
      group: "Actions",
      keywords: ["title", "name", "generate"],
      icon: <Sparkles />,
      available: hasChat,
      run: async () => {
        if (!route.workspaceId) return;
        const id = resolveSessionId(route.workspaceId, new URLSearchParams(window.location.search).get("tab"));
        if (id) await renameWithAi(id);
      },
    },
    {
      id: "pin-chat",
      title: current()?.pinned ? "Unpin Chat" : "Pin Chat",
      group: "Actions",
      icon: current()?.pinned ? <PinOff /> : <Pin />,
      available: hasChat,
      run: async () => {
        const chat = current();
        if (chat) await setWorkspacePinned(chat.id, !chat.pinned);
      },
    },
    {
      // I-073: flags the tab on screen; it stays unread until you leave the chat and come back.
      id: "mark-unread",
      title: current()?.unread ? "Mark as Read" : "Mark as Unread",
      group: "Actions",
      keywords: ["unread", "read", "later"],
      icon: current()?.unread ? <MailOpen /> : <Mail />,
      available: hasChat,
      run: async () => {
        const chat = current();
        if (!chat) return;
        if (chat.unread) return markWorkspaceRead(chat.id);
        const id = resolveSessionId(chat.id, new URLSearchParams(window.location.search).get("tab"));
        if (id) await markSessionUnread(id);
      },
    },
    {
      id: "delete-chat",
      title: "Delete Chat…",
      group: "Actions",
      keywords: ["remove"],
      icon: <Trash2 />,
      available: hasChat,
      run: async () => {
        const chat = current();
        if (!chat) return;
        if (await confirmDeleteChat(chat)) navigate(chat.projectId ? routes.project(chat.projectId) : routes.home(chat.environmentId));
      },
    },
    {
      id: "settings",
      title: "Settings",
      group: "Actions",
      keywords: ["preferences"],
      shortcut: SHORTCUTS.settings,
      icon: <SettingsIcon />,
      run: global.settings,
    },
    ...SETTINGS_SECTIONS.map<Command>((section) => {
      const { label, Icon } = SECTION_INFO[section];
      return {
        id: `settings:${section}`,
        title: `Settings: ${label}`,
        group: "Actions",
        keywords: ["preferences"],
        icon: <Icon />,
        run: () => navigate(routes.settings(section)),
      };
    }),
    ...THEMES.map<Command>(({ value, label, Icon }) => ({
      id: `theme:${value}`,
      title: `Theme: ${label}`,
      group: "Actions",
      keywords: ["appearance", value === "system" ? "system" : "mode"],
      icon: <Icon />,
      run: () => void updateSettings({ appearance: { theme: value } }),
    })),
    {
      id: "refresh-models",
      title: "Refresh Models",
      group: "Actions",
      keywords: ["reload"],
      icon: <RefreshCw />,
      run: async () => {
        await loadModels(true);
        notify("info", "Model list refreshed.");
      },
    },
  );
  return out;
}

export type { GlobalCommandId };
