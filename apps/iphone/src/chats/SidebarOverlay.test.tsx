import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import { RouterProvider, createMemoryRouter } from "react-router";
import { connections } from "@/state/env-registry";
import { savedEnvironments } from "@/state/saved-environments";
import { projects, workspaces } from "@/state/store";
import { makeWorkspace } from "@/test/fixtures";
import { paths } from "~/app/routes";
import { fakeEnv } from "~/test/fake-env";
import { SidebarOverlay } from "./SidebarOverlay";

function renderOverlay(open: boolean) {
  const onClose = vi.fn();
  const router = createMemoryRouter(
    [
      { path: "/e/:envId/chats/:chatId", element: <SidebarOverlay open={open} onClose={onClose} /> },
      { path: "*", element: <div>elsewhere</div> },
    ],
    { initialEntries: [paths.chat("m1", "c1")] },
  );
  const utils = render(<RouterProvider router={router} />);
  return { ...utils, onClose, router };
}

describe("SidebarOverlay", () => {
  beforeEach(() => {
    connections.value = [fakeEnv("m1", "Studio")];
    savedEnvironments.value = [{ id: "m1", name: "Studio", urls: ["http://m1.test:4327"], token: "t" }];
    projects.value = [];
    workspaces.value = [
      makeWorkspace({ id: "c1", title: "Current chat", environmentId: "m1" }),
      makeWorkspace({ id: "c2", title: "Other chat", createdAt: 5, environmentId: "m1" }),
    ];
  });

  it("renders nothing while closed", () => {
    const { container } = renderOverlay(false);
    expect(container.querySelector("[data-sidebar-overlay]")).toBeNull();
  });

  it("shows the chat list with the current chat highlighted", () => {
    renderOverlay(true);
    expect(screen.getByRole("navigation", { name: "Chats" })).toBeTruthy();
    expect(screen.getByText("Current chat").closest("button")?.getAttribute("aria-current")).toBe("page");
  });

  it("closes on a backdrop tap and on Escape", () => {
    const { onClose } = renderOverlay(true);
    fireEvent.click(screen.getByTestId("sidebar-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("closes on a swipe to the left, not on a vertical scroll", () => {
    const { onClose } = renderOverlay(true);
    const nav = screen.getByRole("navigation", { name: "Chats" });
    fireEvent.touchStart(nav, { touches: [{ clientX: 200, clientY: 300 }] });
    fireEvent.touchMove(nav, { touches: [{ clientX: 195, clientY: 450 }] });
    fireEvent.touchEnd(nav, { touches: [] });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.touchStart(nav, { touches: [{ clientX: 250, clientY: 300 }] });
    fireEvent.touchMove(nav, { touches: [{ clientX: 150, clientY: 305 }] });
    fireEvent.touchEnd(nav, { touches: [] });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens a tapped chat and closes", () => {
    const { onClose, router } = renderOverlay(true);
    fireEvent.click(screen.getByText("Other chat"));
    expect(onClose).toHaveBeenCalled();
    expect(router.state.location.pathname).toBe(paths.chat("m1", "c2"));
  });
});
