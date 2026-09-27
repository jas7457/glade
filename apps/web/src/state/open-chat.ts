/**
 * Agent requests to show a chat (`open_chat` push from the `open_chat` tool, I-091). The server
 * message is stored here; `useOpenChatRequests` (app/openChatRequests.ts) navigates to it like a
 * ⌘K pick, once the chat is known to this window (it may arrive before its `workspace_upsert`).
 */
import { signal } from "@preact/signals";
import type { ServerMessage } from "@glade/protocol";

export type OpenChatRequest = Omit<Extract<ServerMessage, { type: "open_chat" }>, "type">;

/** The latest unhandled request (a newer one replaces it). */
export const openChatRequest = signal<OpenChatRequest | null>(null);

export function requestOpenChat(request: OpenChatRequest): void {
  openChatRequest.value = { workspaceId: request.workspaceId, sessionId: request.sessionId, sessionKind: request.sessionKind };
}
