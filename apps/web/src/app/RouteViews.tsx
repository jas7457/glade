/**
 * Route elements: resolve URL params against the stores and render the feature views (new
 * chat, a workspace with its tabs) or a not-found state.
 */
import { Navigate, useParams, useSearchParams } from "react-router";
import { NewChatView } from "@/features/chat";
import { WorkspaceView } from "@/features/workspace";
import { projectsById, resolveSessionId, workspacesById } from "@/state/store";
import { NotFound } from "./NotFound";
import { TAB_PARAM, chatPath } from "./routes";

export function HomeRoute() {
  return <NewChatView projectId={null} />;
}

export function ProjectRoute() {
  const { projectId } = useParams();
  if (!projectId || !projectsById.value.has(projectId)) {
    return <NotFound title="Project not found" message="It may have been removed. Your other projects are in the sidebar." />;
  }
  return <NewChatView key={projectId} projectId={projectId} />;
}

/** `/chats/:chatId` (a workspace id) with optional `?tab=<sessionId>`. */
export function ChatRoute() {
  const { chatId: workspaceId, projectId } = useParams();
  const [search] = useSearchParams();
  const tab = search.get(TAB_PARAM);
  const workspace = workspaceId ? workspacesById.value.get(workspaceId) : undefined;
  if (!workspaceId || !workspace) {
    return <NotFound title="Chat not found" message="It may have been deleted. Your other chats are in the sidebar." />;
  }
  // Keep the URL canonical (inside its project, or standalone; drop a tab that isn't one).
  const sessionId = resolveSessionId(workspaceId, tab);
  const canonicalTab = tab && tab === sessionId ? tab : null;
  if ((workspace.projectId ?? undefined) !== projectId || (tab && !canonicalTab && sessionId)) {
    return <Navigate to={chatPath(workspace, canonicalTab)} replace />;
  }
  if (!sessionId) {
    return <NotFound title="Chat not found" message="This chat has no conversation. Your other chats are in the sidebar." />;
  }
  return <WorkspaceView key={workspaceId} workspaceId={workspaceId} sessionId={sessionId} />;
}
