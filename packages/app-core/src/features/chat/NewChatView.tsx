/**
 * New chat screen: centered empty state with the composer; the chat is created on first send.
 * The context bar above the composer (I-105) picks the project, where the chat works (Local or a
 * new worktree, I-096) and the branch. I-213: in a group project the header names the group and
 * the folder picked for the chat (Folder chip in the context bar), or asks for one.
 */
import { harnessLabel, newChatHarnessFor } from "@glade/app-core/state/harnesses";
import { useEffect } from "preact/hooks";
import { envIdOfProject, foldersById, projectsById } from "@glade/app-core/state/store";
import { environmentLabel, isLocalEnvironment } from "@glade/app-core/state/env-registry";
import { TITLEBAR_HEIGHT } from "@glade/app-core/ui";
import { shortenPath } from "@glade/app-core/lib/paths";
import { newChatFolderFor } from "@glade/app-core/state/new-chat-folder";
import { setNewChatInFolder } from "@glade/app-core/state/new-chat-in-folder";
import { Composer } from "./Composer";
import { ContextBar } from "./context-bar";
import { OpenInButton } from "./OpenInButton";
import { columnClass } from "./Transcript";

/** `/Users/me/src/x` → `~/src/x` (moved to `lib/paths`; re-exported for existing callers). */
export { shortenPath };

/**
 * `envId`: the environment a standalone chat runs on (I-123; null = local/primary).
 * `folderId` (I-215): a sidebar folder of this list the chat starts in (ignored if it isn't one).
 */
export function NewChatView({ projectId, envId = null, folderId = null }: { projectId: string | null; envId?: string | null; folderId?: string | null }) {
  const project = projectId ? projectsById.value.get(projectId) : undefined;
  const target = folderId ? foldersById.value.get(folderId) : undefined;
  const inFolder = target && target.projectId === projectId ? target : null;
  const inFolderId = inFolder?.id ?? null;
  useEffect(() => {
    setNewChatInFolder(inFolderId);
    return () => setNewChatInFolder(null);
  }, [inFolderId]);
  const env = project ? envIdOfProject(project.id) : envId;
  const remote = env && !isLocalEnvironment(env) ? environmentLabel(env) : null;
  // A group project (I-213) has no folder: the chat's own, once picked, is shown instead.
  const folder = project && project.path === null ? newChatFolderFor(project.id) : null;
  const where = project ? (project.path ?? folder) : null;

  return (
    <div class="flex h-full min-h-0 flex-col bg-window">
      <div data-tauri-drag-region style={{ height: `${TITLEBAR_HEIGHT}px` }} class="flex shrink-0 items-center justify-end pr-3">
        {project && project.path !== null && <OpenInButton projectId={project.id} />}
      </div>
      <div class="flex min-h-0 flex-1 flex-col justify-center pb-[12vh]">
        <div class={columnClass}>
          <div class="mb-6 text-center">
            <h1 class="text-[1.7rem] font-semibold tracking-tight">{project ? "What should we work on?" : "New chat"}</h1>
            {project ? (
              <p class="mt-1 text-fg-muted" title={where ?? undefined}>
                {project.name} · <span class="text-fg-subtle">{where ? shortenPath(where) : "Choose a folder for this chat"}</span>
                {inFolder && <FolderNote name={inFolder.name} />}
              </p>
            ) : (
              <p class="mt-1 text-fg-muted">
                Ask anything. Standalone chats run in a scratch folder{remote ? ` on ${remote}` : ""}.
                {inFolder && <FolderNote name={inFolder.name} />}
              </p>
            )}
          </div>
          <ContextBar projectId={project ? project.id : null} envId={project ? null : envId} />
          <Composer
            projectId={projectId}
            envId={project ? null : envId}
            placeholder={project ? `Ask ${harnessLabel(newChatHarnessFor(env)?.id, env)} to work on ${project.name}…` : "Ask anything…"}
          />
        </div>
      </div>
    </div>
  );
}

/** "in <folder>": where the chat will land in the sidebar (I-215). */
function FolderNote({ name }: { name: string }) {
  return (
    <span class="mt-0.5 block text-[0.92em] text-fg-subtle" data-testid="new-chat-folder">
      in {name}
    </span>
  );
}
