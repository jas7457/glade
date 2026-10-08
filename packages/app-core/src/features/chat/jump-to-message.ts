/**
 * Jump to a message when a chat opens (I-093): the ⌘K palette calls {@link requestJump} before
 * navigating to a search hit (bookmarks too, I-203); the chat's `Transcript` takes the request once
 * its transcript is loaded, scrolls the message's start near the top ({@link jumpScrollTop}) and
 * briefly highlights it. Inside an agent reply the target is where its text starts
 * ({@link answerPartIndex}): bookmark ribbons sit there too (I-206).
 *
 * Messages are located by role + timestamp ({@link MessageAnchor}) because harness message ids
 * are positional. A request expires after a few seconds, so one for a chat that never opens
 * (e.g. a sub-agent's) can't fire later.
 */
import { signal } from "@preact/signals";
import type { ChatMessage, MessageAnchor } from "@glade/protocol";
import type { RenderItem, TurnPart } from "./grouping";
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
    return { messageId: id, itemIndex: i, partIndex: answerPartIndex(item.parts, prefix, partIndex) };
  }
  return null;
}

/**
 * Pure: where a reply's answer text starts (I-206): the first text part of the message whose part
 * keys start with `prefix` (what a search matched), else the turn's first text part after `from`
 * (the message's first part: a bookmark anchors a reply's first message, which may hold only
 * thinking / tool calls), else `from`. Without a prefix: the turn's first text part, else 0.
 */
export function answerPartIndex(parts: readonly TurnPart[], prefix?: string, from = 0): number {
  const own = prefix === undefined ? -1 : parts.findIndex((p) => p.type === "text" && p.key.startsWith(prefix));
  if (own !== -1) return own;
  const next = parts.findIndex((p, i) => i >= from && p.type === "text");
  return next === -1 ? from : next;
}

/** Space (px) kept above a jumped-to message (I-206): about 1.5–2 lines. */
export const JUMP_MARGIN = 28;

/**
 * Pure: the `scrollTop` that puts an element's start (`top`, relative to the scroll content) near
 * the top of the viewport (I-206): below `topInset` (anything overlaying the transcript's top, e.g.
 * a glass header or a banner) plus `margin`. Clamped to the scroll range, so a message near the end
 * stops where the transcript ends. Tall elements are aligned the same way (their start shows).
 * One rule for every jump: search hits, bookmarks (list, ⌘K, scroll ticks, iPhone).
 */
export function jumpScrollTop(top: number, viewport: number, scrollHeight: number, { topInset = 0, margin = JUMP_MARGIN }: { topInset?: number; margin?: number } = {}): number {
  const target = top - topInset - margin;
  return Math.max(0, Math.min(Math.round(target), Math.max(0, scrollHeight - viewport)));
}

const HIGHLIGHT_CLASS = "pi-jump-highlight";
const HIGHLIGHT_MS = 2200;

/**
 * The element to scroll to and highlight: the item's element (a child of the transcript column,
 * one per render item), inside a turn the part's element, and for a user message its bubble.
 * `data-aux` children (day dividers, a reply's ribbon slot, footers) don't count.
 */
export function jumpElement(column: HTMLElement, target: JumpTarget): HTMLElement | null {
  // Day dividers (I-111) are column children too; they're marked `data-aux` and don't count.
  const item = counted(column)[target.itemIndex];
  if (!(item instanceof HTMLElement)) return null;
  if (target.partIndex !== null) {
    const part = counted(item)[target.partIndex];
    return part instanceof HTMLElement ? part : item;
  }
  // A user item is a right-aligned column (images, then the text bubble, then its `data-aux`
  // time): highlight the bubble.
  const bubble = item.dataset.role === "user" ? [...item.children].filter((el) => !(el instanceof HTMLElement && el.dataset.aux)).at(-1) : null;
  return bubble instanceof HTMLElement ? bubble : item;
}

function counted(el: Element): Element[] {
  return [...el.children].filter((c) => !(c instanceof HTMLElement && c.dataset.aux));
}

/** Briefly highlight an element (a fading accent ring + tint, `jump.css`). */
export function flashElement(el: HTMLElement): void {
  el.classList.remove(HIGHLIGHT_CLASS);
  void el.offsetWidth; // restart the animation
  el.classList.add(HIGHLIGHT_CLASS);
  setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_MS);
}
