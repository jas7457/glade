/**
 * Where a chat works (I-107), shown in the chat header for chats in git projects:
 * `Local · ⑂ main` or `Worktree · ⑂ glade/sidebar-polish`; the tooltip adds the base branch and
 * the folder. The branch is live: it comes from the changes status (features/changes), which is
 * refreshed on chat open, run end, window focus and by the changes panel. A detached `HEAD`
 * shows its short hash. Nothing for folders that aren't git repositories.
 */
import { GitBranch, GitCommitHorizontal } from "lucide-preact";
import type { WorkspaceSummary } from "@glade/protocol";
import { changesEntry, currentHead } from "@/features/changes";
import { Badge } from "@/ui";

/** The location line's tooltip (and accessible text). */
export function chatLocationTitle(workspace: WorkspaceSummary, head: { name: string; detached: boolean }): string {
  const where = head.detached ? `detached HEAD at ${head.name}` : `branch ${head.name}`;
  const summary = workspace.worktree
    ? `Works in its own worktree on ${where}, from ${workspace.worktree.baseRef}`
    : `Works in the project folder on ${where}`;
  return `${summary}\n${workspace.cwd}`;
}

export function ChatLocation({ workspace, class: className }: { workspace: WorkspaceSummary; class?: string }) {
  const status = changesEntry(workspace.id).status.value;
  const worktree = workspace.worktree;
  // Until the first status arrives, a worktree chat shows the branch it was created on.
  const head = currentHead(workspace.id) ?? (worktree && status === null ? { name: worktree.branch, detached: false } : null);
  if (!workspace.projectId || !head) return null;
  return (
    <Badge
      lead={worktree ? "Worktree" : "Local"}
      icon={head.detached ? <GitCommitHorizontal /> : <GitBranch />}
      title={chatLocationTitle(workspace, head)}
      class={className}
    >
      {head.name}
    </Badge>
  );
}
