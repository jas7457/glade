/**
 * Pure helpers that derive app context from the current URL.
 */
import { matchPath } from "react-router";
import type { ChatSummary } from "@pi-ui/protocol";

export interface RouteContext {
  chatId: string | null;
  /** Project in view: from the URL, or the project of the chat being shown. */
  projectId: string | null;
  isSettings: boolean;
}

export function routeContext(pathname: string, chatsById: ReadonlyMap<string, ChatSummary>): RouteContext {
  const projectChat = matchPath("/projects/:projectId/chats/:chatId", pathname);
  if (projectChat) return { chatId: projectChat.params.chatId!, projectId: projectChat.params.projectId!, isSettings: false };
  const project = matchPath("/projects/:projectId", pathname);
  if (project) return { chatId: null, projectId: project.params.projectId!, isSettings: false };
  const chat = matchPath("/chats/:chatId", pathname);
  if (chat) {
    const chatId = chat.params.chatId!;
    return { chatId, projectId: chatsById.get(chatId)?.projectId ?? null, isSettings: false };
  }
  return { chatId: null, projectId: null, isSettings: pathname.startsWith("/settings") };
}
