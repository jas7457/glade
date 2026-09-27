/**
 * Bits shared by the new-chat context bar's pickers (I-105): the trigger button look and which
 * chats work in a project's own folder right now (they block switching its branch).
 */
import type { WorkspaceSummary } from "@glade/protocol";
import { workspaces } from "@/state/store";

/** A bar button: compact, muted, highlighted while its popover is open (like the composer pickers). */
export const barButtonClass =
  "inline-flex h-[22px] min-w-0 max-w-[240px] items-center gap-1 rounded-control px-1.5 text-[0.92rem] text-fg-muted outline-none " +
  "hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50 data-[state=open]:bg-selected data-[state=open]:text-fg disabled:opacity-40 " +
  "[&>svg]:size-3 [&>svg]:shrink-0";

/** Chats of the project working in its own folder (not in a worktree). */
export function localRunningChats(projectId: string): WorkspaceSummary[] {
  return workspaces.value.filter((w) => w.projectId === projectId && !w.worktree && w.running);
}

/** `"Fix login"` / `"Fix login" and "Tests"` / `"A", "B" and 2 more`. */
export function chatNames(chats: readonly WorkspaceSummary[]): string {
  const names = chats.map((c) => `“${c.title}”`);
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
