/**
 * Pure helpers that derive app context from the current URL.
 */
import { matchPath } from "react-router";
import type { WorkspaceSummary } from "@glade/protocol";
import { parseEnvPath } from "@glade/app-core/app/routes";

export interface RouteContext {
  /** Workspace (sidebar row) in view. `/chats/:chatId` URLs carry workspace ids (I-035). */
  workspaceId: string | null;
  /** Project in view: from the URL, or the project of the workspace being shown. */
  projectId: string | null;
  isSettings: boolean;
  /** Environment in the URL (`/e/:envId/…`, I-123); null = the local one. */
  envId: string | null;
}

export function routeContext(fullPath: string, workspacesById: ReadonlyMap<string, WorkspaceSummary>): RouteContext {
  const { envId, path } = parseEnvPath(fullPath);
  return { ...localContext(path, workspacesById), envId };
}

function localContext(pathname: string, workspacesById: ReadonlyMap<string, WorkspaceSummary>): Omit<RouteContext, "envId"> {
  const projectChat = matchPath("/projects/:projectId/chats/:chatId", pathname);
  if (projectChat) return { workspaceId: projectChat.params.chatId!, projectId: projectChat.params.projectId!, isSettings: false };
  const project = matchPath("/projects/:projectId", pathname);
  if (project) return { workspaceId: null, projectId: project.params.projectId!, isSettings: false };
  const chat = matchPath("/chats/:chatId", pathname);
  if (chat) {
    const workspaceId = chat.params.chatId!;
    return { workspaceId, projectId: workspacesById.get(workspaceId)?.projectId ?? null, isSettings: false };
  }
  return { workspaceId: null, projectId: null, isSettings: pathname.startsWith("/settings") };
}
