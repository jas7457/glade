/**
 * The new-chat context bar (I-105): a slim shelf tucked under the top edge of the new-chat
 * composer with three pickers — project, where the chat works (Local / New worktree; git
 * projects only) and the branch (git projects only). Replaces I-096's "New worktree" switch.
 * The Work-in choice is cleared when the screen goes away (`resetNewChatWorktree`). With several
 * agents installed (ACP agents, I-119) an agent picker comes first. I-123: a chat without a
 * project picks its environment before everything else (when several are connected); the agent
 * list is the chat's environment's.
 */
import { useEffect } from "preact/hooks";
import { loadProjectGit, projectGit, resetNewChatWorktree } from "@/state/worktrees";
import { harnessesOf } from "@/state/harnesses";
import { envIdOfProject } from "@/state/store";
import { EnvironmentPicker } from "@/features/environments/EnvironmentPicker";
import { connections } from "@/state/env-registry";
import { AgentPicker } from "./AgentPicker";
import { BranchPicker } from "./BranchPicker";
import { ProjectPicker } from "./ProjectPicker";
import { WorkInPicker } from "./WorkInPicker";

export function ContextBar({ projectId, envId = null }: { projectId: string | null; /** Standalone chats: the chosen environment. */ envId?: string | null }) {
  useEffect(() => {
    if (!projectId) return;
    void loadProjectGit(projectId);
    // Branches change outside Glade too (terminal, editor): refresh when the window comes back.
    const onFocus = () => void loadProjectGit(projectId);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [projectId]);
  useEffect(() => () => resetNewChatWorktree(), []);
  const git = projectId ? projectGit.value.get(projectId) : undefined;
  const env = projectId ? envIdOfProject(projectId) : envId;

  return (
    <div
      role="toolbar"
      aria-label="New chat context"
      class="mx-3 -mb-3 flex min-w-0 items-center gap-0.5 rounded-t-[12px] bg-tabbar px-1.5 pt-1 pb-[15px] shadow-[0_0_0_0.5px_var(--pi-separator)] select-none"
    >
      {!projectId && connections.value.length > 1 && (
        <>
          <EnvironmentPicker envId={envId} />
          <Divider />
        </>
      )}
      {(harnessesOf(env)?.length ?? 0) > 1 && (
        <>
          <AgentPicker envId={env} />
          <Divider />
        </>
      )}
      <ProjectPicker projectId={projectId} />
      {projectId && git?.isRepo && (
        <>
          <Divider />
          <WorkInPicker projectId={projectId} />
          <Divider />
          <BranchPicker projectId={projectId} git={git} />
        </>
      )}
    </div>
  );
}

function Divider() {
  return <span aria-hidden class="mx-0.5 h-3 w-px shrink-0 bg-separator" />;
}
