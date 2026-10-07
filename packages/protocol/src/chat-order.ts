/**
 * The manual order of chat lists (I-202), shared by the server and every client.
 *
 * A chat list is a project's chats or the standalone Chats section. It has containers: its top
 * level, where chats and the list's folders are mixed in one order, and each folder, which orders
 * its chats. Pinned chats sit above the rest of their container in `pinOrder` (as before I-202);
 * everything else is ordered by `sortOrder` (ascending). New chats and folders get the lowest
 * number of their container (the top). Activity never reorders anything.
 *
 * Items without a `sortOrder` (written by a server from before I-202 while a newer one shares the
 * data folder) sort above the numbered ones, newest first, which is where a new item belongs.
 */

/** Anything with a place in a container: a chat (workspace) or a folder. */
export interface Orderable {
  id: string;
  sortOrder?: number;
  createdAt: number;
}

/** Container order: `sortOrder` ascending (missing first), then newest first, then id. */
export function compareListOrder(a: Orderable, b: Orderable): number {
  const ah = typeof a.sortOrder === "number";
  const bh = typeof b.sortOrder === "number";
  if (ah !== bh) return ah ? 1 : -1;
  if (ah && bh && a.sortOrder !== b.sortOrder) return a.sortOrder! - b.sortOrder!;
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

/** The `sortOrder` that puts a new item above `items` (0 for an empty container). */
export function topSortOrder(items: readonly Orderable[]): number {
  const orders = items.flatMap((i) => (typeof i.sortOrder === "number" ? [i.sortOrder] : []));
  return orders.length ? Math.min(...orders) - 1 : 0;
}
