/**
 * Jump to a message when a chat opens (I-093): the ⌘K palette calls {@link requestJump} before
 * navigating to a search hit; the chat's `Transcript` takes the request once its transcript is
 * loaded, scrolls the message into view (centered) and briefly highlights it.
 *
 * Messages are located by role + timestamp ({@link MessageAnchor}) because harness message ids
 * are positional. A request expires after a few seconds, so one for a chat that never opens
 * (e.g. a sub-agent's) can't fire later.
 */
import { signal } from "@preact/signals";
import type { ChatMessage, MessageAnchor } from "@glade/protocol";
import type { RenderItem } from "./grouping";
import "./jump.css";

export interface JumpRequest {
  sessionId: string;
  message: MessageAnchor;
  at: number;
}

const JUMP_TTL_MS = 10_000;

export const pendingJump = signal<JumpRequest | null>(null);

export function requestJump(sessionId: string, message: MessageAnchor, now = Date.now()): void {
  pendingJump.value = { sessionId, message, at: now };
}

/** The pending request for `sessionId` (cleared once taken), or `null`. */
export function takeJump(sessionId: string, now = Date.now()): MessageAnchor | null {
  const jump = pendingJump.value;
  if (!jump) return null;
  if (now - jump.at > JUMP_TTL_MS) {
    pendingJump.value = null;
    return null;
  }
  if (jump.sessionId !== sessionId) return null;
  pendingJump.value = null;
  return jump.message;
}

/** Where a message is rendered: its item and, inside an assistant turn, the part holding it. */
export interface JumpTarget {
  messageId: string;
  itemIndex: number;
  /** Index of the part (child of the turn element); `null` for user items. */
  partIndex: number | null;
}

/**
 * Pure: find the rendered position of the message `anchor` points at, or `null` if it isn't in
 * the loaded transcript (e.g. compacted away, or folded into a sub-agent card).
 */
export function findJumpTarget(messages: readonly ChatMessage[], items: readonly RenderItem[], anchor: MessageAnchor): JumpTarget | null {
  // Search only indexes text, so on a (rare) timestamp tie prefer a message that has some.
  const same = messages.filter((m) => m.role === anchor.role && m.timestamp === anchor.timestamp);
  const message = same.find((m) => (m.role === "user" || m.role === "assistant") && m.content.some((b) => b.type === "text" && b.text.trim())) ?? same[0];
  if (!message) return null;
  const id = message.id;
  const prefix = `${id}:`;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (anchor.role === "user") {
      if (item.type === "user" && item.message.id === id) return { messageId: id, itemIndex: i, partIndex: null };
      continue;
    }
    if (item.type !== "turn") continue;
    const partIndex = item.parts.findIndex((p) =>
      p.type === "toolGroup" ? p.items.some((g) => g.key.startsWith(prefix)) : p.key.startsWith(prefix),
    );
    if (partIndex === -1) continue;
    // Prefer the message's first text part (what matched) over e.g. its thinking.
    const textIndex = item.parts.findIndex((p) => p.type === "text" && p.key.startsWith(prefix));
    return { messageId: id, itemIndex: i, partIndex: textIndex === -1 ? partIndex : textIndex };
  }
  return null;
}

/**
 * Pure: the `scrollTop` that centers an element (`top` relative to the scroll content) in the
 * viewport. Elements taller than the viewport are aligned to the top with a small margin.
 */
export function centeredScrollTop(top: number, height: number, viewport: number, scrollHeight: number, margin = 24): number {
  const target = height > viewport - 2 * margin ? top - margin : top - (viewport - height) / 2;
  return Math.max(0, Math.min(Math.round(target), Math.max(0, scrollHeight - viewport)));
}

const HIGHLIGHT_CLASS = "pi-jump-highlight";
const HIGHLIGHT_MS = 2200;

/**
 * The element to scroll to and highlight: the item's element (a child of the transcript column,
 * one per render item), inside a turn the part's element, and for a user message its bubble.
 */
export function jumpElement(column: HTMLElement, target: JumpTarget): HTMLElement | null {
  // Day dividers (I-111) are column children too; they're marked `data-aux` and don't count.
  const item = [...column.children].filter((el) => !(el instanceof HTMLElement && el.dataset.aux))[target.itemIndex];
  if (!(item instanceof HTMLElement)) return null;
  if (target.partIndex !== null) {
    const part = item.children[target.partIndex];
    return part instanceof HTMLElement ? part : item;
  }
  // A user item is a right-aligned column (images, then the text bubble, then its `data-aux`
  // time): highlight the bubble.
  const bubble = item.dataset.role === "user" ? [...item.children].filter((el) => !(el instanceof HTMLElement && el.dataset.aux)).at(-1) : null;
  return bubble instanceof HTMLElement ? bubble : item;
}

/** Briefly highlight an element (a fading accent ring + tint, `jump.css`). */
export function flashElement(el: HTMLElement): void {
  el.classList.remove(HIGHLIGHT_CLASS);
  void el.offsetWidth; // restart the animation
  el.classList.add(HIGHLIGHT_CLASS);
  setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_MS);
}
