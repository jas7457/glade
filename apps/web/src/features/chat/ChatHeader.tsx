/**
 * Chat header bar (window drag region): the workspace's editable title, project name (for
 * project chats), its worktree branch (I-096, a subtle chip), the shown session's live status,
 * the changes button (I-097: changed-file count; toggles the changes panel), "Open in VS Code"
 * (project chats) and an overflow menu (rename, pin, delete the workspace).
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { useNavigate } from "react-router";
import { Ellipsis, FileDiff, GitBranch, Pencil, Pin, PinOff, Trash2 } from "lucide-preact";
import { deriveChatStatus, type WorkspaceSummary } from "@glade/protocol";
import { cn } from "@/lib/cn";
import { routes } from "@/app/routes";
import { getChatSession } from "@/state/chat-session";
import { renameWorkspace, setWorkspacePinned } from "@/state/actions";
import { projectsById } from "@/state/store";
import { IconButton, Menu, MenuItem, MenuSeparator, StatusIndicator, TITLEBAR_HEIGHT, ToolbarToggle, Badge, statusLabel } from "@/ui";
import { changedCount } from "@/features/changes";
import { confirmDeleteChat } from "@/features/sidebar/delete-chat";
import { setChangesPanelOpen } from "@/features/workspace/layout-actions";
import { OpenInButton } from "./OpenInButton";

export function ChatHeader({ workspace: chat, sessionId }: { workspace: WorkspaceSummary | undefined; sessionId: string }) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const store = getChatSession(sessionId);
  const project = chat?.projectId ? projectsById.value.get(chat.projectId) : undefined;
  const title = chat?.title ?? "";
  const status = deriveChatStatus({
    running: store.state.value.isRunning,
    pendingInputs: store.uiRequests.value.length,
    unread: false,
  });
  const liveLabel = status === "working" || status === "blocked" ? statusLabel(status) : null;

  const leave = () => navigate(chat?.projectId ? routes.project(chat.projectId) : routes.home());

  const onDelete = async () => {
    if (chat && (await confirmDeleteChat(chat))) leave();
  };

  return (
    <div
      data-tauri-drag-region
      style={{ height: `${TITLEBAR_HEIGHT}px`, paddingLeft: "calc(var(--pi-main-inset-left, 0px) + 16px)" }}
      class="flex shrink-0 items-center gap-2 border-b-[0.5px] border-separator pr-3"
    >
      <div data-tauri-drag-region class="flex min-w-0 flex-1 items-baseline gap-2">
        {editing ? (
          <TitleInput
            value={title}
            onDone={(next) => {
              setEditing(false);
              if (next !== null && next !== title && chat) void renameWorkspace(chat.id, next);
            }}
          />
        ) : (
          <button
            type="button"
            title="Rename"
            onClick={() => chat && setEditing(true)}
            class="min-w-0 max-w-[60%] shrink truncate rounded-[4px] px-1 -mx-1 text-left font-semibold outline-none hover:bg-hover"
          >
            {title || "\u00a0"}
          </button>
        )}
        {project && (
          <span data-tauri-drag-region class={cn("min-w-0 truncate text-[0.92rem] text-fg-subtle", !chat?.worktree && "flex-1")}>
            {project.name}
          </span>
        )}
        {chat?.worktree && (
          <span data-tauri-drag-region class="flex min-w-0 flex-1 items-baseline">
            <Badge
              icon={<GitBranch />}
              title={`Works in its own worktree on branch ${chat.worktree.branch} (from ${chat.worktree.baseRef})`}
              class="self-center"
            >
              {chat.worktree.branch}
            </Badge>
          </span>
        )}
      </div>
      {liveLabel && (
        <div class={cn("flex shrink-0 items-center gap-1.5 text-[0.92rem]", status === "blocked" ? "text-warning" : "text-fg-muted")}>
          <StatusIndicator status={status} tooltip={false} />
          <span>{liveLabel}</span>
        </div>
      )}
      {chat && <ChangesButton workspace={chat} />}
      {project && <OpenInButton projectId={project.id} />}
      <Menu
        align="end"
        trigger={
          <IconButton label="More" tooltip={false} disabled={!chat}>
            <Ellipsis />
          </IconButton>
        }
      >
        <MenuItem icon={<Pencil />} onSelect={() => setEditing(true)}>
          Rename
        </MenuItem>
        <MenuItem
          icon={chat?.pinned ? <PinOff /> : <Pin />}
          onSelect={() => chat && void setWorkspacePinned(chat.id, !chat.pinned)}
        >
          {chat?.pinned ? "Unpin" : "Pin"}
        </MenuItem>
        <MenuSeparator />
        <MenuItem destructive icon={<Trash2 />} onSelect={() => void onDelete()}>
          Delete…
        </MenuItem>
      </Menu>
    </div>
  );
}

/** Toggles the changes panel (I-097); shows how many files git sees changed. */
function ChangesButton({ workspace }: { workspace: WorkspaceSummary }) {
  const count = changedCount(workspace.id);
  const open = workspace.layout?.changesPanelOpen === true;
  return (
    <ToolbarToggle
      icon={<FileDiff />}
      count={count}
      pressed={open}
      label={count ? `${count} changed ${count === 1 ? "file" : "files"}` : "Changes"}
      tooltip={open ? "Hide Changes" : "Show Changes"}
      onClick={() => setChangesPanelOpen(workspace.id, !open)}
    />
  );
}

/** Inline title editor: Enter/blur saves, Escape cancels (`onDone(null)`). */
function TitleInput({ value, onDone }: { value: string; onDone: (value: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const next = ref.current?.value.trim() ?? "";
    onDone(save && next ? next : null);
  };
  return (
    <input
      ref={ref}
      defaultValue={value}
      aria-label="Chat title"
      spellcheck={false}
      class="h-6 min-w-0 max-w-[60%] flex-1 rounded-[4px] bg-control px-1 -mx-1 font-semibold outline-none shadow-[0_0_0_3px_color-mix(in_srgb,var(--pi-accent)_45%,transparent)]"
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.preventDefault(), finish(true));
        if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), finish(false));
      }}
      onBlur={() => finish(true)}
    />
  );
}
