import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { RouterProvider, createMemoryRouter } from "react-router";

vi.mock("@/state/actions", () => ({
  createWorkspace: vi.fn(async () => ({ workspace: { id: "new-ws" }, session: { session: { id: "s1" } } })),
}));

import { createWorkspace } from "@/state/actions";
import { connections } from "@/state/env-registry";
import { savedEnvironments } from "@/state/saved-environments";
import { projects } from "@/state/store";
import { makeProject } from "@/test/fixtures";
import { paths } from "~/app/routes";
import { fakeEnv } from "~/test/fake-env";
import { NewChatScreen, defaultNewChatEnv } from "./NewChatScreen";

function renderNew() {
  const router = createMemoryRouter(
    [
      { path: "/new", element: <NewChatScreen /> },
      { path: "*", element: <div>elsewhere</div> },
    ],
    { initialEntries: ["/", paths.newChat()], initialIndex: 1 },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("NewChatScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connections.value = [fakeEnv("m1", "Studio"), fakeEnv("m2", "Air")];
    savedEnvironments.value = [
      { id: "m1", name: "Studio", urls: ["http://m1.test"], token: "t" },
      { id: "m2", name: "Air", urls: ["http://m2.test"], token: "t" },
    ];
    projects.value = [makeProject({ id: "p1", name: "Alpha", environmentId: "m1" }), makeProject({ id: "p2", name: "Beta", environmentId: "m2" })];
  });

  it("picks the Mac and project, sends the first message, then replaces itself with the chat", async () => {
    const router = renderNew();
    fireEvent.click(screen.getByRole("button", { name: /^Device/ }));
    fireEvent.click(screen.getByRole("button", { name: "Air" }));
    fireEvent.click(screen.getByRole("button", { name: /^Project/ }));
    // Only that Mac's projects are offered.
    expect(screen.queryByRole("button", { name: /Alpha/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Beta/ }));
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText("Message"), { target: { value: "Hello there" } });
    fireEvent.click(send);
    await waitFor(() => expect(router.state.location.pathname).toBe(paths.chat("m2", "new-ws")));
    expect(createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p2", prompt: "Hello there" }), "m2");
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("hides the device row with one Mac and defaults to a connected one", () => {
    connections.value = [fakeEnv("m1", "Studio")];
    renderNew();
    expect(screen.queryByRole("button", { name: /^Device/ })).toBeNull();
    connections.value = [fakeEnv("a", "A", "offline"), fakeEnv("b", "B")];
    expect(defaultNewChatEnv(null)).toBe("b");
    expect(defaultNewChatEnv("a")).toBe("a");
  });
});
