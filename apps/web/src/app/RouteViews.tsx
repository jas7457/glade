/**
 * Route elements: resolve URL params against the stores and render the chat feature views
 * (or a not-found state).
 */
import { Navigate, useParams } from "react-router";
import { ChatView, NewChatView } from "@/features/chat";
import { chatsById, projectsById } from "@/state/store";
import { NotFound } from "./NotFound";
import { chatPath } from "./routes";

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

export function ChatRoute() {
  const { chatId, projectId } = useParams();
  const chat = chatId ? chatsById.value.get(chatId) : undefined;
  if (!chatId || !chat) {
    return <NotFound title="Chat not found" message="It may have been deleted. Your other chats are in the sidebar." />;
  }
  // Keep the URL canonical (chat inside its project, or standalone).
  if ((chat.projectId ?? undefined) !== projectId) return <Navigate to={chatPath(chat)} replace />;
  return <ChatView key={chatId} chatId={chatId} />;
}
