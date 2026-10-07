/**
 * Bookmarks on transcript messages (I-203): the hover button next to a message's time, the accent
 * ribbon on bookmarked messages, and the message's actions (right-click on the desktop: Bookmark /
 * Remove Bookmark, Bookmark Selection, Copy; long-press on touch: a sheet).
 *
 * A message here is a user bubble or a whole agent reply (a turn), anchored by
 * {@link MessageAnchor} (`state/bookmarks.ts`). The transcript provides the session and its
 * bookmarks by anchor through {@link MessageBookmarksContext}; without it (e.g. a preview) the
 * components render nothing extra.
 */
import { cloneElement, createContext, type ComponentChildren, type VNode } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { Bookmark as BookmarkIcon, BookmarkMinus, BookmarkPlus, Copy, TextSelect } from "lucide-preact";
import type { Bookmark, MessageAnchor } from "@glade/protocol";
import { cn } from "@glade/app-core/lib/cn";
import { isIphoneApp } from "@glade/app-core/lib/desktop";
import { addBookmark, removeBookmark } from "@glade/app-core/state/bookmarks";
import { notify } from "@glade/app-core/state/toasts";
import { ContextMenu, MenuItem, MenuSeparator, Tooltip } from "@glade/app-core/ui";
import { useOptionSheet } from "./option-sheet";

/** Key of a message in {@link MessageBookmarksValue.byAnchor}. */
export const anchorKey = (a: MessageAnchor) => `${a.role}:${a.timestamp}`;

export interface MessageBookmarksValue {
  sessionId: string;
  /** The session's bookmarks per message (`anchorKey`). */
  byAnchor: ReadonlyMap<string, Bookmark[]>;
}

export const MessageBookmarksContext = createContext<MessageBookmarksValue | null>(null);

/** Group bookmarks by message. */
export function bookmarksByAnchor(list: readonly Bookmark[]): Map<string, Bookmark[]> {
  const out = new Map<string, Bookmark[]>();
  for (const b of list) {
    const key = anchorKey(b.message);
    const at = out.get(key);
    if (at) at.push(b);
    else out.set(key, [b]);
  }
  return out;
}

function useMessageBookmarks(anchor: MessageAnchor | null) {
  const ctx = useContext(MessageBookmarksContext);
  const all = ctx && anchor ? (ctx.byAnchor.get(anchorKey(anchor)) ?? []) : [];
  return { ctx, all, whole: all.find((b) => !b.selection) };
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    notify("error", `Could not copy: ${(err as Error).message}`);
  }
}

/** Bookmark the message, or remove its (whole-message) bookmark. */
function toggle(sessionId: string, anchor: MessageAnchor, whole: Bookmark | undefined, getText: () => string): void {
  if (whole) void removeBookmark(whole.id);
  else void addBookmark(sessionId, anchor, getText());
}

/**
 * The bookmark toggle shown while the message is hovered (the message sets `group/msg`); stays
 * visible while it's bookmarked or focused. Desktop only: touch uses the long-press sheet.
 */
export function MessageBookmarkButton({ anchor, getText, class: className }: { anchor: MessageAnchor; getText: () => string; class?: string }) {
  const { ctx, whole } = useMessageBookmarks(anchor);
  if (!ctx || isIphoneApp()) return null;
  const label = whole ? "Remove Bookmark" : "Bookmark";
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={!!whole}
        data-testid="message-bookmark"
        onClick={() => toggle(ctx.sessionId, anchor, whole, getText)}
        class={cn(
          "inline-flex size-5 items-center justify-center rounded-[4px] text-fg-subtle outline-none hover:bg-hover hover:text-fg focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent",
          "opacity-0 transition-opacity duration-100 group-hover/msg:opacity-100",
          whole && "text-accent hover:text-accent",
          className,
        )}
      >
        <BookmarkIcon size={13} strokeWidth={2} fill={whole ? "currentColor" : "none"} />
      </button>
    </Tooltip>
  );
}

/**
 * The ribbon on a bookmarked message: a small accent bookmark in the gutter beside it (the parent
 * is `relative`). Marked `data-aux` (jump-to-message skips it). Its tooltip names the bookmarks.
 */
export function BookmarkRibbon({ anchor, class: className }: { anchor: MessageAnchor; class?: string }) {
  const { all } = useMessageBookmarks(anchor);
  if (!all.length) return null;
  const title = all.map((b) => (b.selection ? `Bookmarked passage: ${b.label}` : `Bookmarked: ${b.label}`)).join("\n");
  return (
    <span
      data-aux="ribbon"
      data-testid="bookmark-ribbon"
      role="img"
      aria-label={title}
      title={title}
      class={cn("pointer-events-auto absolute flex text-accent select-none", className)}
    >
      <BookmarkIcon size={12} strokeWidth={2} fill="currentColor" />
    </span>
  );
}

/** The selected text when it lies inside `el` (empty otherwise). */
function selectionIn(el: Element | null): string {
  const sel = typeof window === "undefined" ? null : window.getSelection();
  if (!el || !sel || sel.isCollapsed || sel.rangeCount === 0) return "";
  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return "";
  return sel.toString().trim();
}

const LONG_PRESS_MS = 500;

/** The message an element belongs to (its item root carries `data-anchor`, see {@link anchorKey}). */
export function anchorAt(el: Element | null, within: Element): MessageAnchor | null {
  const item = el?.closest?.("[data-anchor]");
  if (!item || !within.contains(item)) return null;
  const [role, ts] = (item.getAttribute("data-anchor") ?? "").split(":");
  const timestamp = Number(ts);
  return (role === "user" || role === "assistant") && Number.isFinite(timestamp) ? { role, timestamp } : null;
}

interface MenuTarget {
  anchor: MessageAnchor;
  /** Selected text inside the message ("" for none). */
  selection: string;
}

/**
 * The messages' actions, for the whole transcript column (`children`, one element): right-click
 * on a message (desktop), long-press (touch, `isIphoneApp`: a sheet). Bookmark / Remove
 * Bookmark, Copy; with text selected in the message also Copy and Bookmark Selection. Links and
 * everything that isn't a message keep the system menu. `textOf` gives a message's text.
 */
export function MessageMenu({ textOf, children }: { textOf: (anchor: MessageAnchor) => string; children: VNode }) {
  const ctx = useContext(MessageBookmarksContext);
  const OptionSheet = useOptionSheet();
  const touch = isIphoneApp();
  const [target, setTarget] = useState<MenuTarget | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  if (!ctx) return children;
  const { sessionId } = ctx;
  const anchor = target?.anchor ?? null;
  const all = anchor ? (ctx.byAnchor.get(anchorKey(anchor)) ?? []) : [];
  const whole = all.find((b) => !b.selection);
  const text = () => (anchor ? textOf(anchor) : "");
  const isUser = anchor?.role === "user";

  if (touch) {
    if (!OptionSheet) return children;
    const cancel = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
    const element = cloneElement(children, {
      onTouchStart: (e: TouchEvent) => {
        cancel();
        const at = anchorAt(e.target as Element, e.currentTarget as Element);
        if (!at || (e.target as Element).closest?.("a[href], button")) return;
        timer.current = setTimeout(() => {
          timer.current = null;
          window.getSelection()?.removeAllRanges();
          setTarget({ anchor: at, selection: "" });
          setSheetOpen(true);
        }, LONG_PRESS_MS);
      },
      onTouchMove: cancel,
      onTouchEnd: cancel,
      onTouchCancel: cancel,
    });
    const close = (fn: () => void) => () => {
      setSheetOpen(false);
      fn();
    };
    return (
      <>
        {element}
        {anchor && (
          <OptionSheet
            open={sheetOpen}
            onClose={() => setSheetOpen(false)}
            title={isUser ? "Your Message" : "Agent Reply"}
            sections={[
              {
                items: [
                  {
                    key: "bookmark",
                    label: whole ? "Remove Bookmark" : "Bookmark",
                    icon: whole ? <BookmarkMinus size={20} /> : <BookmarkPlus size={20} />,
                    onSelect: close(() => toggle(sessionId, anchor, whole, text)),
                  },
                  { key: "copy", label: "Copy", icon: <Copy size={20} />, onSelect: close(() => void copyText(text())) },
                ],
              },
            ]}
          />
        )}
      </>
    );
  }

  const element = cloneElement(children, {
    onContextMenuCapture: (e: MouseEvent) => {
      const at = anchorAt(e.target as Element, e.currentTarget as Element);
      // Links and anything that isn't a message keep the system menu: stop the event before the
      // menu's trigger sees it.
      if (!at || (e.target as Element | null)?.closest?.("a[href]")) return e.stopPropagation();
      const item = (e.target as Element).closest("[data-anchor]");
      setTarget({ anchor: at, selection: selectionIn(item) });
    },
  });
  const selection = target?.selection ?? "";
  const items: ComponentChildren = anchor && (
    <>
      {selection && (
        <>
          <MenuItem icon={<Copy />} onSelect={() => void copyText(selection)}>
            Copy
          </MenuItem>
          <MenuItem icon={<TextSelect />} onSelect={() => void addBookmark(sessionId, anchor, text(), { selection })}>
            Bookmark Selection
          </MenuItem>
          <MenuSeparator />
        </>
      )}
      <MenuItem icon={whole ? <BookmarkMinus /> : <BookmarkPlus />} onSelect={() => toggle(sessionId, anchor, whole, text)}>
        {whole ? "Remove Bookmark" : isUser ? "Bookmark Message" : "Bookmark Reply"}
      </MenuItem>
      <MenuItem icon={<Copy />} onSelect={() => void copyText(text())}>
        {isUser ? "Copy Message" : "Copy Reply as Markdown"}
      </MenuItem>
    </>
  );
  return <ContextMenu content={items}>{element}</ContextMenu>;
}
