/**
 * New chat screen: centered empty state with the composer; the chat is created on first send.
 * In a git project a "New worktree" switch under the composer (I-096, off by default) makes the
 * chat work on its own branch in its own folder.
 */
import { useEffect, useId } from "preact/hooks";
import { GitBranch } from "lucide-preact";
import { harnessLabel } from "@/state/harnesses";
import { projectsById } from "@/state/store";
import { loadProjectGit, newChatWorktree, projectGit } from "@/state/worktrees";
import { Switch, TITLEBAR_HEIGHT } from "@/ui";
import { Composer } from "./Composer";
import { OpenInButton } from "./OpenInButton";
import { columnClass } from "./Transcript";

/** `/Users/me/src/x` → `~/src/x` (best effort; the server doesn't tell us $HOME). */
export function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

export function NewChatView({ projectId }: { projectId: string | null }) {
  const project = projectId ? projectsById.value.get(projectId) : undefined;

  return (
    <div class="flex h-full min-h-0 flex-col bg-window">
      <div data-tauri-drag-region style={{ height: `${TITLEBAR_HEIGHT}px` }} class="flex shrink-0 items-center justify-end pr-3">
        {project && <OpenInButton projectId={project.id} />}
      </div>
      <div class="flex min-h-0 flex-1 flex-col justify-center pb-[12vh]">
        <div class={columnClass}>
          <div class="mb-6 text-center">
            <h1 class="text-[1.7rem] font-semibold tracking-tight">{project ? "What should we work on?" : "New chat"}</h1>
            {project ? (
              <p class="mt-1 text-fg-muted" title={project.path}>
                {project.name} · <span class="text-fg-subtle">{shortenPath(project.path)}</span>
              </p>
            ) : (
              <p class="mt-1 text-fg-muted">Ask anything. Standalone chats run in a scratch folder.</p>
            )}
          </div>
          <Composer projectId={projectId} placeholder={project ? `Ask ${harnessLabel()} to work on ${project.name}…` : "Ask anything…"} />
          {project && <WorktreeSwitch projectId={project.id} />}
        </div>
      </div>
    </div>
  );
}

/** "New worktree" switch for git projects; the state is cleared when the screen goes away. */
export function WorktreeSwitch({ projectId }: { projectId: string }) {
  const id = useId();
  useEffect(() => {
    void loadProjectGit(projectId);
  }, [projectId]);
  useEffect(() => () => void (newChatWorktree.value = null), []);
  const git = projectGit.value.get(projectId);
  if (!git?.isRepo) return null;
  const on = newChatWorktree.value === projectId;
  return (
    <div class="mt-2 flex items-center gap-2 px-1 text-[0.92rem] text-fg-muted select-none">
      <Switch id={id} size="sm" checked={on} onCheckedChange={(checked) => (newChatWorktree.value = checked ? projectId : null)} />
      <label for={id} class="flex min-w-0 items-center gap-1" title="Work on a new branch in a separate folder, so this chat's changes stay apart from the project folder">
        <GitBranch size={12} class="shrink-0" />
        <span>New worktree</span>
        {git.branch && <span class="truncate text-fg-subtle">· branches off {git.branch}</span>}
      </label>
    </div>
  );
}
