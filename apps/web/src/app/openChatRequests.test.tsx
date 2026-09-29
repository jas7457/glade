/** I-091: an agent's `open_chat` push navigates the window to that chat, like a ⌘K pick. */
import { beforeEach, describe, expect, it } from "vitest";
import { act, render, waitFor } from "@testing-library/preact";
import { createMemoryRouter, RouterProvider } from "react-router";
import { handleServerMessage, workspaces, workspacesById } from "@glade/app-core/state/store";
import { openChatRequest } from "@glade/app-core/state/open-chat";
import { makeWorkspace } from "@glade/app-core/test/fixtures";
import { openChatPath, useOpenChatRequests } from "./openChatRequests";

beforeEach(() => {
  openChatRequest.value = null;
  workspaces.value = [makeWorkspace({ id: "w", projectId: "p" }), makeWorkspace({ id: "solo", projectId: null })];
});

describe("openChatPath", () => {
  it("opens main sessions as their tab and sub-agents via their workspace", () => {
    expect(openChatPath({ workspaceId: "w", sessionId: "s1", sessionKind: "main" }, workspacesById.value)).toBe("/projects/p/chats/w?tab=s1");
    expect(openChatPath({ workspaceId: "solo", sessionId: "a", sessionKind: "subagent" }, workspacesById.value)).toBe("/chats/solo");
    expect(openChatPath({ workspaceId: "unknown", sessionId: "x", sessionKind: "main" }, workspacesById.value)).toBeNull();
  });
});

function Probe() {
  useOpenChatRequests();
  return null;
}

describe("useOpenChatRequests", () => {
  it("navigates on the server push, waiting for a workspace it doesn't know yet", async () => {
    const router = createMemoryRouter([{ path: "*", element: <Probe /> }], { initialEntries: ["/"] });
    render(<RouterProvider router={router} />);
    act(() => handleServerMessage({ type: "open_chat", workspaceId: "solo", sessionId: "s2", sessionKind: "main" }));
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe("/chats/solo?tab=s2"));
    expect(openChatRequest.value).toBeNull();

    act(() => handleServerMessage({ type: "open_chat", workspaceId: "later", sessionId: "s3", sessionKind: "main" }));
    expect(router.state.location.pathname).toBe("/chats/solo");
    act(() => {
      workspaces.value = [...workspaces.value, makeWorkspace({ id: "later", projectId: null })];
    });
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe("/chats/later?tab=s3"));
  });
});
