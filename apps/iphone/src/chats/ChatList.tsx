/**
 * The iPhone chat list (I-164, doc §5.2/§5.4), used by Home and the sidebar overlay: every
 * connected Mac's chats grouped by project like the desktop sidebar (merged, with a device
 * marker when more than one Mac is connected), pinned first, status (working / needs you /
 * unread) or the relative time, search by title, and a row per Mac that is down or connecting.
 * Long-press (or right-click) on a chat opens its actions (Rename, Pin, Mark as Read, Delete).
 */
import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import { ChevronDown, ChevronRight, Folder, Monitor, Pin } from "lucide-preact";
import { aggregateChatStatus, type WorkspaceSummary } from "@glade/protocol";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/features/sidebar/time";
import { connectionFor, connections, multipleEnvironments } from "@/state/env-registry";
import { remoteStateOf, remoteStateText } from "@/state/remote-status";
import { envIdOf } from "@/state/store";
import { closedProjects, setProjectOpen } from "@/state/ui";
import { Spinner, StatusIndicator } from "@/ui";
import { DeviceMarker } from "~/ui/phone-extra";
import { ChatActionsSheet } from "./ChatActionsSheet";
import { chatGroups } from "./chat-groups";

/** Chats shown per project before "Show More" (all of them while searching). */
export const PHONE_PROJECT_LIMIT = 5;

export interface ChatListProps {
  query?: string;
  /** Highlighted chat (the one on screen behind the overlay). */
  selectedChatId?: string | null;
  /** A chat was tapped. */
  onOpen: (chat: WorkspaceSummary) => void;
  /** A Mac's status row was tapped. */
  onOpenDevice?: (envId: string) => void;
  /** Shown in the empty state when set. */
  onNewChat?: () => void;
}

export function ChatList({ query = "", selectedChatId = null, onOpen, onOpenDevice, onNewChat }: ChatListProps) {
  const groups = chatGroups(query);
  const searching = query.trim().length > 0;
  const expanded = useSignal<ReadonlySet<string>>(new Set());
  const actionsFor = useSignal<WorkspaceSummary | null>(null);
  const multi = multipleEnvironments.value;
  const closed = closedProjects.value;
  const remotes = connections.value.filter((c) => !c.isLocal);
  const noneConnected = remotes.length > 0 && remotes.every((c) => remoteStateOf(c.id) !== "connected");

  return (
    <div class="pb-2" data-chat-list>
      <EnvironmentStatusRows onOpenDevice={onOpenDevice} />
      {groups.length === 0 && <EmptyState query={query} noneConnected={noneConnected} onNewChat={onNewChat} />}
      {groups.map((group) => {
        if (group.kind === "standalone") {
          return (
            <section key={group.key} class="mx-4 mb-5" aria-label="Chats">
              <h2 class="px-4 pb-1.5 text-[13px] text-fg-muted uppercase">Chats</h2>
              <Rows chats={group.chats} limit={Infinity} expanded selectedChatId={selectedChatId} onOpen={onOpen} onActions={(c) => (actionsFor.value = c)} showDevice={multi} />
            </section>
          );
        }
        const { project } = group;
        const open = searching || !closed.has(project.id);
        const aggregate = open ? "idle" : aggregateChatStatus(group.chats.map((c) => c.status));
        const more = expanded.value.has(project.id);
        return (
          <section key={group.key} class="mx-4 mb-5" aria-label={project.name} data-project-id={project.id}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => !searching && setProjectOpen(project.id, !open)}
              class="flex min-h-9 w-full items-center gap-1.5 px-1 pb-1.5 text-left select-none"
            >
              <Folder size={15} class="shrink-0 text-fg-muted" aria-hidden />
              <span class="min-w-0 truncate text-[15px] font-semibold text-fg-strong">{project.name}</span>
              {multi && <DeviceMarker name={connectionFor(envIdOf(project))?.name.value ?? ""} />}
              <span class="flex-1" />
              {aggregate !== "idle" && <StatusIndicator status={aggregate} tooltip={false} />}
              {!searching && (open ? <ChevronDown size={17} class="shrink-0 text-fg-subtle" aria-hidden /> : <ChevronRight size={17} class="shrink-0 text-fg-subtle" aria-hidden />)}
            </button>
            {open &&
              (group.chats.length === 0 ? (
                <div class="rounded-xl bg-cell px-4 py-2.5 text-[15px] text-fg-subtle">No chats</div>
              ) : (
                <Rows
                  chats={group.chats}
                  limit={searching ? Infinity : PHONE_PROJECT_LIMIT}
                  expanded={more}
                  onToggleMore={() => {
                    const next = new Set(expanded.value);
                    if (more) next.delete(project.id);
                    else next.add(project.id);
                    expanded.value = next;
                  }}
                  selectedChatId={selectedChatId}
                  onOpen={onOpen}
                  onActions={(c) => (actionsFor.value = c)}
                  showDevice={false}
                />
              ))}
          </section>
        );
      })}
      <ChatActionsSheet chat={actionsFor.value} onClose={() => (actionsFor.value = null)} />
    </div>
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
  chats,
  limit,
  expanded,
  onToggleMore,
  selectedChatId,
  onOpen,
  onActions,
  showDevice,
}: {
  chats: WorkspaceSummary[];
  limit: number;
  expanded: boolean;
  onToggleMore?: () => void;
  selectedChatId: string | null;
  onOpen: (chat: WorkspaceSummary) => void;
  onActions: (chat: WorkspaceSummary) => void;
  showDevice: boolean;
}) {
  const selectedIdx = selectedChatId ? chats.findIndex((c) => c.id === selectedChatId) : -1;
  const count = expanded ? chats.length : Math.min(chats.length, Math.max(limit, selectedIdx + 1));
  return (
    <div role="list" class="overflow-hidden rounded-xl bg-cell [&>*+*]:border-t [&>*+*]:border-separator">
      {chats.slice(0, count).map((chat) => (
        <ChatRow key={chat.id} chat={chat} selected={chat.id === selectedChatId} onOpen={onOpen} onActions={onActions} showDevice={showDevice} />
      ))}
      {chats.length > limit && onToggleMore && (
        <button type="button" onClick={onToggleMore} class="flex min-h-11 w-full items-center px-4 text-left text-[15px] text-accent active:bg-hover">
          {expanded ? "Show Less" : `Show ${chats.length - count} More`}
        </button>
      )}
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
}: {
  chat: WorkspaceSummary;
  selected: boolean;
  onOpen: (chat: WorkspaceSummary) => void;
  onActions: (chat: WorkspaceSummary) => void;
  showDevice: boolean;
}) {
  // Long-press opens the actions; the click that follows the release is swallowed.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressed = useRef(false);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const unread = chat.status === "unread" && !selected;
  return (
    <div role="listitem">
      <button
        type="button"
        data-chat-id={chat.id}
        aria-current={selected ? "page" : undefined}
        onClick={() => {
          if (pressed.current) {
            pressed.current = false;
            return;
          }
          onOpen(chat);
        }}
        onTouchStart={() => {
          pressed.current = false;
          cancel();
          timer.current = setTimeout(() => {
            pressed.current = true;
            onActions(chat);
          }, LONG_PRESS_MS);
        }}
        onTouchMove={cancel}
        onTouchEnd={cancel}
        onTouchCancel={cancel}
        onContextMenu={(e) => {
          e.preventDefault();
          cancel();
          if (!pressed.current) onActions(chat);
        }}
        class={cn("flex min-h-11 w-full items-center gap-2 px-4 py-2.5 text-left select-none active:bg-hover", selected && "bg-selected")}
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
          <button
            key={r.id}
            type="button"
            data-down-environment={r.id}
            onClick={() => onOpenDevice?.(r.id)}
            class="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left text-fg-muted select-none active:bg-hover"
          >
            <Monitor size={20} class="shrink-0" aria-hidden />
            <span class="min-w-0 flex-1 truncate">{r.state === "connecting" ? `Connecting to ${r.name}…` : remoteStateText(r.state, r.name)}</span>
            {r.state === "connecting" ? <Spinner size={14} /> : <span class="shrink-0 text-fg-subtle" aria-hidden>›</span>}
          </button>
        ))}
      </div>
    </section>
  );
}
