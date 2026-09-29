/** I-083: reopen the last screen on startup at `/`, unless it's gone or the URL is explicit. */
import { beforeEach, describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/preact";
import { createMemoryRouter, RouterProvider } from "react-router";
import { initialized, projects, workspaces, projectsById, workspacesById } from "@/state/store";
import { previousRoute, readStored } from "@/state/ui";
import { makeProject, makeWorkspace } from "@/test/fixtures";
import { resetLastRouteForTests, restorableRoute, startupRoute, useLastRoute } from "./lastRoute";

beforeEach(() => {
  localStorage.clear();
  resetLastRouteForTests();
  projects.value = [makeProject({ id: "p" })];
  workspaces.value = [makeWorkspace({ id: "w", projectId: "p" }), makeWorkspace({ id: "solo", projectId: null })];
  initialized.value = true;
});

const data = () => ({ workspacesById: workspacesById.value, projectsById: projectsById.value });

describe("restorableRoute", () => {
  it("keeps routes whose chat/project/settings page still exists, incl. the tab", () => {
    expect(restorableRoute("/projects/p/chats/w?tab=s2", data())).toBe("/projects/p/chats/w?tab=s2");
    expect(restorableRoute("/chats/solo", data())).toBe("/chats/solo");
    expect(restorableRoute("/projects/p", data())).toBe("/projects/p");
    expect(restorableRoute("/settings/remote", data())).toBe("/settings/remote");
  });
  it("drops deleted chats/projects, unknown pages, home and garbage", () => {
    expect(restorableRoute("/projects/p/chats/gone?tab=x", data())).toBeNull();
    expect(restorableRoute("/chats/gone", data())).toBeNull();
    expect(restorableRoute("/projects/gone", data())).toBeNull();
    expect(restorableRoute("/settings/nope", data())).toBeNull();
    expect(restorableRoute("/", data())).toBeNull();
    expect(restorableRoute("https://evil.example/", data())).toBeNull();
    expect(restorableRoute(null, data())).toBeNull();
  });
});

describe("startupRoute", () => {
  it("only restores when the app opened at plain /", () => {
    expect(startupRoute("/", "/chats/solo", data())).toBe("/chats/solo");
    expect(startupRoute("/projects/p", "/chats/solo", data())).toBeNull();
    expect(startupRoute("/?x=1", "/chats/solo", data())).toBeNull();
  });
});

function Probe(props: { initialUrl: string; stored: string | null }) {
  useLastRoute(props);
  return null;
}

function renderAt(url: string, stored: string | null) {
  const router = createMemoryRouter([{ path: "*", element: <Probe initialUrl={url} stored={stored} /> }], { initialEntries: [url] });
  render(<RouterProvider router={router} />);
  return router;
}

describe("useLastRoute", () => {
  it("reads the previous route from storage", () => {
    expect(previousRoute).toBeNull();
  });

  it("restores a valid last route at /", async () => {
    const router = renderAt("/", "/projects/p/chats/w?tab=s2");
    await Promise.resolve();
    expect(router.state.location.pathname + router.state.location.search).toBe("/projects/p/chats/w?tab=s2");
  });

  it("stays home when the last chat was deleted", async () => {
    const router = renderAt("/", "/projects/p/chats/gone");
    await Promise.resolve();
    expect(router.state.location.pathname).toBe("/");
    expect(readStored("glade.lastRoute")).toBe("/");
  });

  it("never overrides an explicit URL, and remembers navigations", async () => {
    const router = renderAt("/chats/solo", "/projects/p/chats/w");
    await Promise.resolve();
    expect(router.state.location.pathname).toBe("/chats/solo");
    expect(readStored("glade.lastRoute")).toBe("/chats/solo");
    await router.navigate("/settings/models");
    await waitFor(() => expect(readStored("glade.lastRoute")).toBe("/settings/models"));
  });

  it("waits for data before deciding", async () => {
    initialized.value = false;
    const router = renderAt("/", "/chats/solo");
    await Promise.resolve();
    expect(router.state.location.pathname).toBe("/");
    expect(readStored("glade.lastRoute")).toBeNull();
  });
});
