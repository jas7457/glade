/**
 * Chat lists with folders (I-165, I-202): the pure part of how the sidebar (and the iPhone list)
 * shows a list (a project's chats, or the standalone Chats section). `store.ts` feeds it the
 * signals.
 *
 * - A list shows its pinned chats outside folders first (`pinOrder`), then one manual order of
 *   its other chats and its folders mixed (`sortOrder`, `compareListOrder`); each folder shows its
 *   pinned chats, then its other chats (same rules).
 * - Each environment keeps its own order on its server; a list mixing environments (the
 *   standalone chats) interleaves them as this device arranged them (`env-order.ts` slots).
 * - A membership only counts when the folder exists in the same environment and fits (a
 *   Chats-section folder for standalone chats, the chat's own project's folder otherwise);
 *   anything else shows outside, so a stale id never hides a row.
 *
 * Portable client core (F-022).
 */
import { compareFolders, compareListOrder, type Folder, type Workspace } from "@glade/protocol";
import { interleave, type OrderKey } from "./env-order";

type EnvOf = (item: { environmentId?: string }) => string;

/** What a chat needs to be placed in a list. */
export type ListChat = Pick<Workspace, "id" | "projectId" | "pinned" | "pinOrder" | "sortOrder" | "createdAt" | "folderId"> & { environmentId?: string };

/** One entry of a list's mixed order: a chat, or a folder with its chats. */
export type ChatListEntry<W extends ListChat = ListChat> = { kind: "chat"; chat: W } | { kind: "folder"; folder: Folder; chats: W[] };

/** A list as shown: pinned chats outside folders, then the mixed order. */
export interface ChatListView<W extends ListChat = ListChat> {
  pinned: W[];
  entries: ChatListEntry<W>[];
}

/** The folder a chat is in (a Chats-section one for standalone chats, its project's otherwise), or null. */
export function workspaceFolderId(workspace: Pick<Workspace, "folderId" | "projectId"> & { environmentId?: string }, foldersById: ReadonlyMap<string, Folder>, envOf: EnvOf): string | null {
  if (!workspace.folderId) return null;
  const folder = foldersById.get(workspace.folderId);
  return folder && envOf(folder) === envOf(workspace) && folder.projectId === workspace.projectId ? folder.id : null;
}

/** One project's folders (or, `null`, the Chats section's) in their order. */
export function foldersOfProject(folders: readonly Folder[], projectId: string | null): Folder[] {
  return folders.filter((f) => f.projectId === projectId).sort(compareFolders);
}

const byPinOrder = (a: ListChat, b: ListChat) => (a.pinOrder ?? Number.MAX_SAFE_INTEGER) - (b.pinOrder ?? Number.MAX_SAFE_INTEGER) || compareListOrder(a, b);

/** A container's chats as shown: pinned first (`pinOrder`), then the manual order. */
export function orderChats<W extends ListChat>(chats: readonly W[]): W[] {
  return [...chats.filter((c) => c.pinned).sort(byPinOrder), ...chats.filter((c) => !c.pinned).sort(compareListOrder)];
}

function byEnv<T>(items: readonly T[], envOf: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const env = envOf(item);
    const list = out.get(env);
    if (list) list.push(item);
    else out.set(env, [item]);
  }
  return out;
}

export interface ChatListInput<W extends ListChat> {
  /** The list's chats (every environment's). */
  chats: readonly W[];
  /** The list's folders (every environment's). */
  folders: readonly Folder[];
  foldersById: ReadonlyMap<string, Folder>;
  envOf: EnvOf;
  /** This device's interleave of environments: pinned chats, and the mixed order. */
  pinSlots: readonly OrderKey[];
  orderSlots: readonly OrderKey[];
  envOrder: readonly string[];
}

/** Build a list as shown (see the header). */
export function buildChatList<W extends ListChat>(input: ChatListInput<W>): ChatListView<W> {
  const { chats, folders, foldersById, envOf } = input;
  const inside = new Map<string, W[]>();
  const loose: W[] = [];
  for (const chat of chats) {
    const folderId = workspaceFolderId(chat, foldersById, envOf);
    if (folderId === null) loose.push(chat);
    else {
      const list = inside.get(folderId);
      if (list) list.push(chat);
      else inside.set(folderId, [chat]);
    }
  }
  const pinnedPerEnv = new Map([...byEnv(loose.filter((c) => c.pinned), envOf)].map(([env, list]) => [env, list.sort(byPinOrder)]));
  const pinned = interleave(input.pinSlots, pinnedPerEnv, input.envOrder);
  type Sorted = { sort: { id: string; sortOrder?: number; createdAt: number }; entry: ChatListEntry<W> };
  const mixed: Sorted[] = [
    ...loose.filter((c) => !c.pinned).map((chat): Sorted => ({ sort: chat, entry: { kind: "chat", chat } })),
    ...folders.map((folder): Sorted => ({ sort: folder, entry: { kind: "folder", folder, chats: orderChats(inside.get(folder.id) ?? []) } })),
  ];
  const perEnv = byEnv(mixed, (x) => envOf(x.entry.kind === "chat" ? x.entry.chat : x.entry.folder));
  const sorted = new Map([...perEnv].map(([env, list]) => [env, list.sort((a, b) => compareListOrder(a.sort, b.sort)).map((x) => x.entry)]));
  return { pinned, entries: interleave(input.orderSlots, sorted, input.envOrder) };
}

/** Id of an entry (chat or folder id). */
export const chatEntryId = (e: ChatListEntry): string => (e.kind === "chat" ? e.chat.id : e.folder.id);

/** Every chat of a list view in display order (pinned, then entries with folders' chats in place). */
export function chatsOfView<W extends ListChat>(view: ChatListView<W>): W[] {
  return [...view.pinned, ...view.entries.flatMap((e) => (e.kind === "chat" ? [e.chat] : e.chats))];
}
