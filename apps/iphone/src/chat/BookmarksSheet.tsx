/**
 * A chat's bookmarks on the iPhone (I-203): the nav bar's bookmark button (shown once the chat has
 * one; bookmark a message by long-pressing it) opens this sheet. Tap a bookmark: its tab opens and
 * the message scrolls into view with a flash. Long-press (or right-click) a bookmark for its
 * actions: Reference in Message (a chip in the composer, sent as a short quote), Copy, Rename,
 * Remove.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { Bookmark as BookmarkIcon, Copy, MessageSquareQuote, Pencil, TextSelect, Trash2 } from "lucide-preact";
import type { Bookmark } from "@glade/protocol";
import { bookmarksOfWorkspace, removeBookmark, renameBookmark } from "@glade/app-core/state/bookmarks";
import { bookmarks } from "@glade/app-core/state/store";
import { copyBookmark, jumpToBookmark, referenceBookmark } from "@glade/app-core/features/chat/bookmark-actions";
import { dayLabel, formatMessageTime } from "@glade/app-core/features/chat/message-time";
import { ListGroup, ListRow, NavIconButton, PhoneButton, PhoneInput, Sheet } from "~/ui/phone";

const LONG_PRESS_MS = 450;

function when(ts: number, now = Date.now()): string {
  const day = dayLabel(ts, now);
  return day === "Today" ? formatMessageTime(ts) : day;
}

/** The nav bar button with the chat's bookmark count (nothing while it has none). */
export function BookmarksNavButton({ workspaceId, onOpen }: { workspaceId: string; onOpen: () => void }) {
  const count = bookmarksOfWorkspace(workspaceId, bookmarks.value).length;
  if (!count) return null;
  return (
    <NavIconButton label={`${count} ${count === 1 ? "bookmark" : "bookmarks"}`} onClick={onOpen} class="relative w-auto min-w-11 gap-0.5 px-2">
      <BookmarkIcon size={21} />
      <span class="text-[15px] font-medium tabular-nums">{count}</span>
    </NavIconButton>
  );
}

type Mode = { kind: "list" } | { kind: "actions"; bookmark: Bookmark } | { kind: "rename"; bookmark: Bookmark };

export function BookmarksSheet({
  open,
  onClose,
  workspaceId,
  sessionId,
  onOpenSession,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  /** The session on screen: references go to its composer. */
  sessionId: string;
  /** Show the session holding a bookmark (when it isn't the one on screen). */
  onOpenSession: (sessionId: string) => void;
}) {
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) setMode({ kind: "list" });
  }, [open]);
  const list = bookmarksOfWorkspace(workspaceId, bookmarks.value);
  const run = (fn: () => unknown) => {
    onClose();
    void fn();
  };

  const jump = (b: Bookmark) =>
    run(() => {
      jumpToBookmark(b);
      if (b.sessionId !== sessionId) onOpenSession(b.sessionId);
    });

  if (mode.kind === "rename") {
    const b = mode.bookmark;
    const save = () => run(() => renameBookmark(b.id, name.trim() || null));
    return (
      <Sheet
        open={open}
        onClose={onClose}
        title="Rename Bookmark"
        action={
          <PhoneButton kind="plain" onClick={save}>
            Save
          </PhoneButton>
        }
      >
        <form
          class="px-4 pt-1 pb-3"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <PhoneInput aria-label="Bookmark name" placeholder="Name (empty: automatic)" value={name} autoFocus onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
        </form>
      </Sheet>
    );
  }

  if (mode.kind === "actions") {
    const b = mode.bookmark;
    return (
      <Sheet open={open} onClose={onClose} title={b.label}>
        <div class="pt-1">
          <ListGroup>
            <ListRow icon={<BookmarkIcon size={20} />} title="Show Message" onClick={() => jump(b)} />
            <ListRow icon={<MessageSquareQuote size={20} />} title="Reference in Message" onClick={() => run(() => referenceBookmark(b, sessionId))} />
            <ListRow icon={<Copy size={20} />} title="Copy" onClick={() => run(() => copyBookmark(b))} />
            <ListRow
              icon={<Pencil size={20} />}
              title="Rename…"
              onClick={() => {
                setName(b.labelSource === "user" ? b.label : "");
                setMode({ kind: "rename", bookmark: b });
              }}
            />
          </ListGroup>
          <ListGroup>
            <ListRow icon={<Trash2 size={20} />} title="Remove Bookmark" tone="danger" onClick={() => run(() => removeBookmark(b.id))} />
          </ListGroup>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet open={open} onClose={onClose} title="Bookmarks" full={list.length > 6}>
      <div class="pt-1">
        {list.length === 0 ? (
          <p class="px-6 py-8 text-center text-[15px] text-fg-muted">No bookmarks in this chat. Long-press a message to bookmark it.</p>
        ) : (
          <ListGroup footer="Tap to show a message; touch and hold for more.">
            {list.map((b) => (
              <PressRow key={b.id} bookmark={b} onTap={() => jump(b)} onLong={() => setMode({ kind: "actions", bookmark: b })} />
            ))}
          </ListGroup>
        )}
      </div>
    </Sheet>
  );
}

/** A bookmark row: tap runs `onTap`, touch-and-hold (or right-click) `onLong`. */
function PressRow({ bookmark: b, onTap, onLong }: { bookmark: Bookmark; onTap: () => void; onLong: () => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressed = useRef(false);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);
  return (
    <div
      onTouchStart={() => {
        pressed.current = false;
        cancel();
        timer.current = setTimeout(() => {
          pressed.current = true;
          onLong();
        }, LONG_PRESS_MS);
      }}
      onTouchMove={cancel}
      onTouchEnd={cancel}
      onTouchCancel={cancel}
      onContextMenu={(e) => {
        e.preventDefault();
        cancel();
        if (!pressed.current) onLong();
      }}
      onClickCapture={(e) => {
        // The click that ends a long press isn't a tap.
        if (!pressed.current) return;
        pressed.current = false;
        e.stopPropagation();
      }}
    >
      <ListRow
        icon={b.selection ? <TextSelect size={20} class="text-accent" /> : <BookmarkIcon size={20} class="text-accent" fill="currentColor" />}
        title={b.label}
        subtitle={b.excerpt && b.excerpt !== b.label ? b.excerpt : undefined}
        detail={when(b.message.timestamp)}
        onClick={onTap}
      />
    </div>
  );
}
