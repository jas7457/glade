/**
 * Follows agents' `open_chat` requests (I-091): navigates to the requested chat like a ⌘K pick
 * (main sessions open their tab; sub-agents open their workspace).
 */
import { useEffect } from "preact/hooks";
import { useNavigate } from "react-router";
import { openChatRequest, type OpenChatRequest } from "@glade/app-core/state/open-chat";
import { workspacesById } from "@glade/app-core/state/store";
import { chatPath } from "@glade/app-core/app/routes";

/** Where a request leads, or `null` while its workspace isn't known yet. */
export function openChatPath(request: OpenChatRequest, workspaces: ReadonlyMap<string, { id: string; projectId: string | null }>): string | null {
  const workspace = workspaces.get(request.workspaceId);
  if (!workspace) return null;
  return chatPath(workspace, request.sessionKind === "main" ? request.sessionId : null);
}

export function useOpenChatRequests(): void {
  const navigate = useNavigate();
  const request = openChatRequest.value;
  const workspaces = workspacesById.value;
  useEffect(() => {
    if (!request) return;
    const to = openChatPath(request, workspaces);
    if (!to) return;
    openChatRequest.value = null;
    void navigate(to);
  }, [request, workspaces]);
}
