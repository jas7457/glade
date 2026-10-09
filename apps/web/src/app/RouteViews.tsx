/**
 * Route elements: resolve URL params against the stores and render the feature views (new
 * chat, a workspace with its tabs) or a not-found state. `/e/:envId/…` routes (I-123) name the
 * environment; without it the local one is meant. A URL whose environment doesn't match the
 * item's is redirected to the canonical one; an environment that is still connecting shows a
 * spinner instead of "not found".
 */
import { Navigate, useParams, useSearchParams } from "react-router";
import { NewChatView } from "@/features/chat";
import { WorkspaceView } from "@/features/workspace";
import { activeTerminalId } from "@/features/workspace/layout";
import { connectionFor, isLocalEnvironment } from "@glade/app-core/state/env-registry";
import { envIdOfProject, envIdOfWorkspace, projectsById, resolveSessionId, workspacesById } from "@glade/app-core/state/store";
import { Spinner } from "@glade/app-core/ui";
import { NotFound } from "./NotFound";
import { FOLDER_PARAM, TAB_PARAM, chatPath, envPrefix, routes } from "@glade/app-core/app/routes";

/** The URL names this environment (no `/e/` = local). */
function sameEnv(urlEnv: string | undefined, itemEnv: string): boolean {
  return urlEnv ? urlEnv === itemEnv || (isLocalEnvironment(urlEnv) && isLocalEnvironment(itemEnv)) : isLocalEnvironment(itemEnv);
}

/** The URL's environment is connected but hasn't loaded its lists yet. */
function stillLoading(urlEnv: string | undefined): boolean {
  if (!urlEnv) return false;
  const conn = connectionFor(urlEnv);
  return !!conn && !conn.shell.initialized.value && conn.status.value !== "error";
}

function Loading() {
  return (
    <div class="flex h-full items-center justify-center">
      <Spinner size={16} />
    </div>
  );
}

export function HomeRoute() {
  const { envId } = useParams();
  const folderId = useSearchParams()[0].get(FOLDER_PARAM);
  if (envId) {
    // `/e/<local id>` is just the local new-chat screen.
    if (isLocalEnvironment(envId) || !envPrefix(envId)) return <Navigate to={routes.home()} replace />;
    if (!connectionFor(envId)) {
      return <NotFound title="Environment not connected" message="Turn on remote access in Settings, or connect to it again." />;
    }
  }
  return <NewChatView key={envId ?? ""} projectId={null} envId={envId ?? null} folderId={folderId} />;
}

export function ProjectRoute() {
  const { projectId, envId } = useParams();
  const [search] = useSearchParams();
  if (!projectId || !projectsById.value.has(projectId)) {
    if (stillLoading(envId)) return <Loading />;
    return <NotFound title="Project not found" message="It may have been removed. Your other projects are in the sidebar." />;
  }
  if (!sameEnv(envId, envIdOfProject(projectId))) return <Navigate to={routes.project(projectId)} replace />;
  return <NewChatView key={projectId} projectId={projectId} folderId={search.get(FOLDER_PARAM)} />;
}

/** `/chats/:chatId` (a workspace id) with optional `?tab=<sessionId>`. */
export function ChatRoute() {
  const { chatId: workspaceId, projectId, envId } = useParams();
  const [search] = useSearchParams();
  const tab = search.get(TAB_PARAM);
  const workspace = workspaceId ? workspacesById.value.get(workspaceId) : undefined;
  if (!workspaceId || !workspace) {
    if (stillLoading(envId)) return <Loading />;
    return <NotFound title="Chat not found" message="It may have been deleted. Your other chats are in the sidebar." />;
  }
  // Keep the URL canonical (inside its project, or standalone, on its environment; drop a tab that isn't one).
  // A terminal tab (I-187) is a tab too; the conversation behind it is the workspace's focused one.
  const terminalId = activeTerminalId(workspace.layout, tab);
  const sessionId = resolveSessionId(workspaceId, terminalId ? null : tab);
  const canonicalTab = tab && (tab === sessionId || tab === terminalId) ? tab : null;
  if ((workspace.projectId ?? undefined) !== projectId || (tab && !canonicalTab && sessionId) || !sameEnv(envId, envIdOfWorkspace(workspaceId))) {
    return <Navigate to={chatPath(workspace, canonicalTab)} replace />;
  }
  if (!sessionId) {
    return <NotFound title="Chat not found" message="This chat has no conversation. Your other chats are in the sidebar." />;
  }
  return <WorkspaceView key={workspaceId} workspaceId={workspaceId} sessionId={sessionId} terminalId={terminalId} />;
}
