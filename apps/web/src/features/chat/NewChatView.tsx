/**
 * New chat screen: centered empty state with the composer; the chat is created on first send.
 * The context bar above the composer (I-105) picks the project, where the chat works (Local or a
 * new worktree, I-096) and the branch.
 */
import { harnessLabel, newChatHarnessFor } from "@/state/harnesses";
import { envIdOfProject, projectsById } from "@/state/store";
import { environmentLabel, isLocalEnvironment } from "@/state/env-registry";
import { TITLEBAR_HEIGHT } from "@/ui";
import { Composer } from "./Composer";
import { ContextBar } from "./context-bar";
import { OpenInButton } from "./OpenInButton";
import { columnClass } from "./Transcript";

/** `/Users/me/src/x` → `~/src/x` (best effort; the server doesn't tell us $HOME). */
export function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** `envId`: the environment a standalone chat runs on (I-123; null = local/primary). */
export function NewChatView({ projectId, envId = null }: { projectId: string | null; envId?: string | null }) {
  const project = projectId ? projectsById.value.get(projectId) : undefined;
  const env = project ? envIdOfProject(project.id) : envId;
  const remote = env && !isLocalEnvironment(env) ? environmentLabel(env) : null;

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
              <p class="mt-1 text-fg-muted">Ask anything. Standalone chats run in a scratch folder{remote ? ` on ${remote}` : ""}.</p>
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
