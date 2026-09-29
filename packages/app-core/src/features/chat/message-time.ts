/**
 * Message times in the transcript (I-111). Pure helpers, locale-aware through `Intl` (the
 * browser's locale picks 24h "14:32" or 12h "2:32 PM"); `locale` is a parameter so tests can pin
 * it, `now` so "Today"/"Yesterday" are testable.
 *
 * - {@link formatMessageTime}: the short time shown next to a message on hover.
 * - {@link formatMessageDateTime}: the full date and time for its tooltip.
 * - {@link dayLabel} / {@link dayDividers}: the thin "Today" / "Yesterday" / "Thu 25 Sep" rows
 *   where the day changes between messages.
 */

/** "14:32" / "2:32 PM". */
export function formatMessageTime(ts: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(ts);
}

/** "Sat 27 Sep 2026, 14:32:05" (order and punctuation per locale). */
export function formatMessageDateTime(ts: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(ts);
}

/** Local calendar day of a timestamp, as a comparable number (yyyymmdd). */
export function dayKey(ts: number): number {
  const d = new Date(ts);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/** "Today", "Yesterday", "Thu 25 Sep", or "Thu 25 Sep 2025" for another year. */
export function dayLabel(ts: number, now: number, locale?: string): string {
  const key = dayKey(ts);
  if (key === dayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday.getTime())) return "Yesterday";
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(ts);
}

/**
 * The day divider to show before each message (null = none): where the day changes from the
 * previous message, and before the first one when it isn't from today (so an old chat says
 * when it's from). Messages without a usable time (0 / NaN) never get one and don't count.
 */
export function dayDividers(timestamps: readonly (number | null | undefined)[], now: number, locale?: string): (string | null)[] {
  let prev: number | null = null;
  let first = true;
  return timestamps.map((ts) => {
    if (!ts || !Number.isFinite(ts)) return null;
    const key = dayKey(ts);
    const show = first ? key !== dayKey(now) : key !== prev;
    first = false;
    prev = key;
    return show ? dayLabel(ts, now, locale) : null;
  });
}
