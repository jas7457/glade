/**
 * The iPhone chat list (I-164, doc §5.2/§5.4), used by Home and the sidebar overlay: every
 * connected Mac's chats grouped by project like the desktop sidebar (merged, with a device
 * marker when more than one Mac is connected), pinned first, status (working / needs you /
 * unread) or the relative time, search by title, and a row per Mac that is down or connecting.
 * Long-press (or right-click) on a chat opens its actions (Rename, Pin, Move to Folder, Mark as
 * Read, Delete). Each list (a project's, or the standalone Chats) shows its pinned chats, then its
 * chats and folders in their one manual order (I-202, set by dragging on the Mac); a folder's row
 * opens in place. Long-press on a folder opens its actions, on a project header "New Folder".
 *
 * Search (I-167): titles filter instantly; after a pause, hits from inside the chats ("In
 * Conversations") and an "✦ Ask" row follow (`ChatSearchResults`, `chat-search.ts`). Opening one
 * jumps to the matched message.
 */
import { MacStatusRow } from "~/ui/MacStatus";
import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import { ChevronDown, ChevronRight, Folders as FoldersIcon, Pin } from "lucide-preact";
import { aggregateChatStatus, type Folder, type Project, type WorkspaceSummary } from "@glade/protocol";
import { cn } from "@glade/app-core/lib/cn";
import { ProjectIcon } from "@glade/app-core/ui/ProjectIcon";
import { formatRelativeTime } from "@glade/app-core/features/sidebar/time";
import { connectionFor, connections, multipleEnvironments } from "@glade/app-core/state/env-registry";
import { remoteStateOf } from "@glade/app-core/state/remote-status";
import { envIdOf, workspacesById } from "@glade/app-core/state/store";
import { closedProjects, setProjectOpen } from "@glade/app-core/state/ui";
import { requestJump } from "@glade/app-core/features/chat/jump-to-message";
import { StatusIndicator } from "@glade/app-core/ui";
import { DeviceMarker } from "~/ui/phone-extra";
import { ChatActionsSheet } from "./ChatActionsSheet";
import { FolderActionsSheet, ProjectActionsSheet } from "./FolderSheets";
import { allChatsOf, chatGroups, type ListEntry, type ProjectGroup as ProjectGroupData } from "./chat-groups";
import { SEARCH_MIN_CHARS, useAsk, useContentSearch, type SessionTarget } from "./chat-search";
import { ChatSearchResults } from "./ChatSearchResults";

/** Chats shown per project before "Show More" (all of them while searching). */
export const PHONE_PROJECT_LIMIT = 5;

export interface ChatListProps {
  query?: string;
  /** Highlighted chat (the one on screen behind the overlay). */
  selectedChatId?: string | null;
  /** A chat was tapped. */
  onOpen: (chat: WorkspaceSummary) => void;
  /**
   * A search result from inside a chat was tapped (I-167): open that session (`paths.chat(envId,
   * workspaceId, sessionId)`). The jump to the matched message is already requested.
   */
  onOpenSession?: (target: SessionTarget) => void;
  /** A Mac's status row was tapped. */
  onOpenDevice?: (envId: string) => void;
  /** Shown in the empty state when set. */
  onNewChat?: () => void;
}

type Actions = { kind: "chat"; chat: WorkspaceSummary } | { kind: "folder"; folder: Folder } | { kind: "project"; project: Project };

export function ChatList({ query = "", selectedChatId = null, onOpen, onOpenSession, onOpenDevice, onNewChat }: ChatListProps) {
  const groups = chatGroups(query);
  const searching = query.trim().length > 0;
  const deepSearch = query.trim().length >= SEARCH_MIN_CHARS;
  const content = useContentSearch(query);
  const ask = useAsk(query);
  const expanded = useSignal<ReadonlySet<string>>(new Set());
  const actions = useSignal<Actions | null>(null);
  const multi = multipleEnvironments.value;
  const remotes = connections.value.filter((c) => !c.isLocal);
  const noneConnected = remotes.length > 0 && remotes.every((c) => remoteStateOf(c.id) !== "connected");
  const onActions = (c: WorkspaceSummary) => (actions.value = { kind: "chat", chat: c });
  const toggleMore = (id: string) => {
    const next = new Set(expanded.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded.value = next;
  };
  const openTarget = (t: SessionTarget) => {
    if (t.message) requestJump(t.sessionId, t.message);
    if (onOpenSession) return onOpenSession(t);
    const chat = workspacesById.value.get(t.workspaceId);
    if (chat) onOpen(chat);
  };
  // Nothing matched anywhere (titles, and inside the chats once that search is back).
  const nothing = groups.length === 0 && (!deepSearch || (content.status === "done" && content.hits.length === 0));
  const ctx: SectionContext = {
    searching,
    selectedChatId,
    onOpen,
    onActions,
    onFolderActions: (folder) => (actions.value = { kind: "folder", folder }),
    onProjectActions: (project) => (actions.value = { kind: "project", project }),
    expanded: expanded.value,
    toggleMore,
    multi,
  };

  return (
    <div class="pb-2" data-chat-list>
      <EnvironmentStatusRows onOpenDevice={onOpenDevice} />
      {nothing && <EmptyState query={query} noneConnected={noneConnected} onNewChat={onNewChat} />}
      {groups.map((group) => {
        if (group.kind === "standalone") {
          return (
            <section key={group.key} class="mx-4 mb-5" aria-label="Chats">
              <h2 class="px-4 pb-1.5 text-[13px] text-fg-muted uppercase">Chats</h2>
              <Rows
                pinned={group.pinned}
                entries={group.entries}
                limit={Infinity}
                expanded
                searching={searching}
                selectedChatId={selectedChatId}
                onOpen={onOpen}
                onActions={onActions}
                onFolderActions={ctx.onFolderActions}
                showDevice={multi}
              />
            </section>
          );
        }
        return <ProjectSection key={group.key} group={group} ctx={ctx} />;
      })}
      {deepSearch && <ChatSearchResults query={query} content={content} ask={ask.state} onAsk={ask.run} onOpen={openTarget} multi={multi} />}
      <ChatActionsSheet chat={actions.value?.kind === "chat" ? actions.value.chat : null} onClose={() => (actions.value = null)} />
      <FolderActionsSheet folder={actions.value?.kind === "folder" ? actions.value.folder : null} onClose={() => (actions.value = null)} />
      <ProjectActionsSheet project={actions.value?.kind === "project" ? actions.value.project : null} onClose={() => (actions.value = null)} />
    </div>
  );
}

interface SectionContext {
  searching: boolean;
  selectedChatId: string | null;
  onOpen: (chat: WorkspaceSummary) => void;
  onActions: (chat: WorkspaceSummary) => void;
  onFolderActions: (folder: Folder) => void;
  onProjectActions: (project: Project) => void;
  expanded: ReadonlySet<string>;
  toggleMore: (id: string) => void;
  multi: boolean;
}

/** Long-press (or right-click) runs `onLong`; the click that follows the release is swallowed. */
function useLongPress(onLong: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressed = useRef(false);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    /** Call from onClick: true when the click ends a long-press (ignore it). */
    consumed: () => {
      if (!pressed.current) return false;
      pressed.current = false;
      return true;
    },
    handlers: {
      onTouchStart: () => {
        pressed.current = false;
        cancel();
        timer.current = setTimeout(() => {
          pressed.current = true;
          onLong();
        }, LONG_PRESS_MS);
      },
      onTouchMove: cancel,
      onTouchEnd: cancel,
      onTouchCancel: cancel,
      onContextMenu: (e: Event) => {
        e.preventDefault();
        cancel();
        if (!pressed.current) onLong();
      },
    },
  };
}

/** A project: its pinned chats, then its chats and folders (each expandable in place). */
function ProjectSection({ group, ctx }: { group: ProjectGroupData; ctx: SectionContext }) {
  const { project } = group;
  const open = ctx.searching || !closedProjects.value.has(project.id);
  const aggregate = open ? "idle" : aggregateChatStatus(allChatsOf(group).map((c) => c.status));
  const more = ctx.expanded.has(project.id);
  const press = useLongPress(() => ctx.onProjectActions(project));
  const empty = group.pinned.length === 0 && group.entries.length === 0;
  return (
    <section class="mx-4 mb-5" aria-label={project.name} data-project-id={project.id}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => !press.consumed() && !ctx.searching && setProjectOpen(project.id, !open)}
        {...press.handlers}
        class="flex min-h-9 w-full items-center gap-1.5 px-1 pb-1.5 text-left select-none"
      >
        {/* Folder, or stacked layers for a group project (I-213). */}
        <ProjectIcon project={project} size={15} class="shrink-0 text-fg-muted" />
        <span class="min-w-0 truncate text-[15px] font-semibold text-fg-strong">{project.name}</span>
        {ctx.multi && <DeviceMarker name={connectionFor(envIdOf(project))?.name.value ?? ""} />}
        <span class="flex-1" />
        {aggregate !== "idle" && <StatusIndicator status={aggregate} tooltip={false} />}
        {!ctx.searching && (open ? <ChevronDown size={17} class="shrink-0 text-fg-subtle" aria-hidden /> : <ChevronRight size={17} class="shrink-0 text-fg-subtle" aria-hidden />)}
      </button>
      {open &&
        (empty ? (
          <div class="rounded-xl bg-cell px-4 py-2.5 text-[15px] text-fg-subtle">No chats</div>
        ) : (
          <Rows
            pinned={group.pinned}
            entries={group.entries}
            limit={ctx.searching ? Infinity : PHONE_PROJECT_LIMIT}
            expanded={more}
            onToggleMore={() => ctx.toggleMore(project.id)}
            searching={ctx.searching}
            selectedChatId={ctx.selectedChatId}
            onOpen={ctx.onOpen}
            onActions={ctx.onActions}
            onFolderActions={ctx.onFolderActions}
            showDevice={false}
          />
        ))}
    </section>
  );
}

function EmptyState({ query, noneConnected, onNewChat }: { query: string; noneConnected: boolean; onNewChat?: () => void }) {
  if (query.trim()) return <p class="px-8 py-10 text-center text-fg-muted">No chats match “{query.trim()}”.</p>;
  // Every Mac is down or connecting: their status rows above say so.
  if (noneConnected) return <p class="px-8 py-6 text-center text-[15px] text-fg-muted">Chats show up here once your Mac is connected.</p>;
  return (
    <div class="flex flex-col items-center px-8 py-12 text-center">
      <p class="text-[20px] font-semibold text-fg-strong">No chats yet</p>
      <p class="mt-1 text-[15px] text-fg-muted">Chats from your Macs show up here.</p>
      {onNewChat && (
        <button type="button" onClick={onNewChat} class="mt-4 min-h-11 rounded-xl px-4 text-[17px] font-semibold text-accent active:opacity-60">
          Start a Chat
        </button>
      )}
    </div>
  );
}

function Rows({
  pinned,
  entries,
  limit,
  expanded,
  onToggleMore,
  searching = false,
  selectedChatId,
  onOpen,
  onActions,
  onFolderActions,
  showDevice,
}: {
  pinned: WorkspaceSummary[];
  /** The list's chats and folders in their manual order (I-202). */
  entries: ListEntry[];
  /** Entries shown before "Show More" (pinned chats always show). */
  limit: number;
  expanded: boolean;
  onToggleMore?: () => void;
  searching?: boolean;
  selectedChatId: string | null;
  onOpen: (chat: WorkspaceSummary) => void;
  onActions: (chat: WorkspaceSummary) => void;
  onFolderActions?: (folder: Folder) => void;
  showDevice: boolean;
}) {
  const holds = (e: ListEntry, id: string) => (e.kind === "chat" ? e.chat.id === id : e.chats.some((c) => c.id === id));
  const selectedIdx = selectedChatId ? entries.findIndex((e) => holds(e, selectedChatId)) : -1;
  const count = expanded ? entries.length : Math.min(entries.length, Math.max(limit, selectedIdx + 1));
  const closed = closedProjects.value;
  const row = (chat: WorkspaceSummary, inFolder = false) => (
    <ChatRow key={chat.id} chat={chat} selected={chat.id === selectedChatId} onOpen={onOpen} onActions={onActions} showDevice={showDevice} inFolder={inFolder} />
  );
  return (
    <div role="list" class="overflow-hidden rounded-xl bg-cell [&>*+*]:border-t [&>*+*]:border-separator">
      {pinned.map((chat) => row(chat))}
      {entries.slice(0, count).flatMap((e) => {
        if (e.kind === "chat") return [row(e.chat)];
        const open = searching || !closed.has(e.folder.id);
        return [
          <FolderRow key={`f:${e.folder.id}`} folder={e.folder} chats={e.chats} open={open} searching={searching} onActions={onFolderActions} />,
          ...(open ? e.chats.map((chat) => row(chat, true)) : []),
        ];
      })}
      {entries.length > limit && onToggleMore && (
        <button type="button" onClick={onToggleMore} class="flex min-h-11 w-full items-center px-4 text-left text-[15px] text-accent active:bg-hover">
          {expanded ? "Show Less" : `Show ${entries.length - count} More`}
        </button>
      )}
    </div>
  );
}

/** A project's folder inside its list: tap opens/closes it in place, long-press for its actions. */
function FolderRow({ folder, chats, open, searching, onActions }: { folder: Folder; chats: WorkspaceSummary[]; open: boolean; searching: boolean; onActions?: (folder: Folder) => void }) {
  const press = useLongPress(() => onActions?.(folder));
  const aggregate = open ? "idle" : aggregateChatStatus(chats.map((c) => c.status));
  return (
    <div role="listitem">
      <button
        type="button"
        data-folder-id={folder.id}
        aria-expanded={open}
        onClick={() => !press.consumed() && !searching && setProjectOpen(folder.id, !open)}
        {...press.handlers}
        class="flex min-h-11 w-full items-center gap-2 px-4 py-2.5 text-left select-none active:bg-hover"
      >
        <FoldersIcon size={17} class="shrink-0 text-fg-muted" aria-hidden />
        <span class="min-w-0 flex-1 truncate">{folder.name}</span>
        {aggregate !== "idle" ? (
          <StatusIndicator status={aggregate} size={16} tooltip={false} />
        ) : (
          <span class="shrink-0 text-[15px] text-fg-muted">{chats.length}</span>
        )}
        {!searching && (open ? <ChevronDown size={17} class="shrink-0 text-fg-subtle" aria-hidden /> : <ChevronRight size={17} class="shrink-0 text-fg-subtle" aria-hidden />)}
      </button>
    </div>
  );
}

const LONG_PRESS_MS = 500;

function ChatRow({
  chat,
  selected,
  onOpen,
  onActions,
  showDevice,
  inFolder,
}: {
  chat: WorkspaceSummary;
  selected: boolean;
  onOpen: (chat: WorkspaceSummary) => void;
  onActions: (chat: WorkspaceSummary) => void;
  showDevice: boolean;
  /** Listed under its folder's row (indented). */
  inFolder?: boolean;
}) {
  const press = useLongPress(() => onActions(chat));
  const unread = chat.status === "unread" && !selected;
  return (
    <div role="listitem">
      <button
        type="button"
        data-chat-id={chat.id}
        aria-current={selected ? "page" : undefined}
        onClick={() => {
          if (!press.consumed()) onOpen(chat);
        }}
        {...press.handlers}
        class={cn("flex min-h-11 w-full items-center gap-2 px-4 py-2.5 text-left select-none active:bg-hover", inFolder && "pl-[41px]", selected && "bg-selected")}
      >
        <span class={cn("min-w-0 flex-1 truncate", unread && "font-semibold text-fg-strong")}>{chat.title || "Untitled"}</span>
        {showDevice && <DeviceMarker name={connectionFor(envIdOf(chat))?.name.value ?? ""} />}
        {chat.pinned && <Pin size={13} class="shrink-0 text-fg-subtle" aria-label="Pinned" />}
        {chat.status !== "idle" ? (
          <StatusIndicator status={chat.status} failed={chat.lastRunFailed} size={16} tooltip={false} />
        ) : (
          <span class="shrink-0 text-[15px] text-fg-muted">{formatRelativeTime(chat.lastActivityAt)}</span>
        )}
      </button>
    </div>
  );
}

/** A row per Mac that isn't connected: connecting (spinner) or down ("MacBook Air is offline"). */
function EnvironmentStatusRows({ onOpenDevice }: { onOpenDevice?: (envId: string) => void }) {
  const rows = connections.value
    .filter((c) => !c.isLocal)
    .map((c) => ({ id: c.id, name: c.name.value, state: remoteStateOf(c.id) }))
    .filter((r) => r.state !== "connected");
  if (rows.length === 0) return null;
  return (
    <section class="mx-4 mb-5" aria-label="Devices">
      <div class="overflow-hidden rounded-xl bg-cell [&>*+*]:border-t [&>*+*]:border-separator">
        {rows.map((r) => (
          <MacStatusRow key={r.id} envId={r.id} onOpen={onOpenDevice} />
        ))}
      </div>
    </section>
  );
}
