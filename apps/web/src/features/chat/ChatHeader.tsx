/**
 * Chat header bar (window drag region): editable title, project / cwd subtitle, live status
 * and an overflow menu (rename, pin, delete).
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { useNavigate } from "react-router";
import { Ellipsis, Pencil, Pin, PinOff, Trash2 } from "lucide-preact";
import { deriveChatStatus, type ChatSummary } from "@pi-ui/protocol";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import { routes } from "@/app/routes";
import { getChatSession, runAction } from "@/state/chat-session";
import { projectsById } from "@/state/store";
import { IconButton, Menu, MenuItem, MenuSeparator, StatusIndicator, TITLEBAR_HEIGHT, confirm, statusLabel } from "@/ui";

/** `/Users/me/src/x` → `~/src/x` (best effort; the server doesn't tell us $HOME). */
export function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

export function ChatHeader({ chat, chatId }: { chat: ChatSummary | undefined; chatId: string }) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const store = getChatSession(chatId);
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
    const ok = await confirm({
      title: `Delete “${title || "this chat"}”?`,
      message: "The conversation will be permanently deleted. This can't be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    if (await runAction(() => api.deleteChat(chatId), "Could not delete chat")) leave();
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
              if (next !== null && next !== title) void runAction(() => api.updateChat(chatId, { title: next }), "Could not rename chat");
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
        {chat && (
          <span data-tauri-drag-region class="min-w-0 flex-1 truncate text-[0.92rem] text-fg-subtle" title={chat.cwd}>
            {project ? `${project.name} · ` : ""}
            {shortenPath(chat.cwd)}
          </span>
        )}
      </div>
      {liveLabel && (
        <div class={cn("flex shrink-0 items-center gap-1.5 text-[0.92rem]", status === "blocked" ? "text-warning" : "text-fg-muted")}>
          <StatusIndicator status={status} tooltip={false} />
          <span>{liveLabel}</span>
        </div>
      )}
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
          onSelect={() => chat && void runAction(() => api.updateChat(chatId, { pinned: !chat.pinned }), "Could not pin chat")}
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
