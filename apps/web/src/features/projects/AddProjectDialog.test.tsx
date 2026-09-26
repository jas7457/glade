import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/preact";

vi.mock("@/lib/api", () => ({
  api: { listDirectory: vi.fn(), createProject: vi.fn() },
}));

import { api } from "@/lib/api";
import { TooltipProvider } from "@/ui";
import { projects } from "@/state/store";
import { makeProject } from "@/test/fixtures";
import { AddProjectDialog } from "./AddProjectDialog";
import { folderName, pathSegments, validateProjectPath } from "./validation";

const mocked = vi.mocked(api);

/** Blur a field. preact/compat listens for `focusout`, which testing-library's fireEvent.blur doesn't send. */
const leave = (el: HTMLElement) => act(() => void el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));

describe("validation", () => {
  it("requires an absolute or ~ path", () => {
    expect(validateProjectPath("")).toMatch(/Choose/);
    expect(validateProjectPath("code/x")).toMatch(/absolute/);
    expect(validateProjectPath("~/code/x")).toBeNull();
    expect(validateProjectPath("~")).toBeNull();
    expect(validateProjectPath("/tmp")).toBeNull();
  });
  it("folderName + pathSegments", () => {
    expect(folderName("/a/b/")).toBe("b");
    expect(pathSegments("/a/b")).toEqual([
      { name: "/", path: "/" },
      { name: "a", path: "/a" },
      { name: "b", path: "/a/b" },
    ]);
  });
});

describe("AddProjectDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projects.value = [];
    mocked.listDirectory.mockImplementation(async (path?: string) => ({
      path: path ?? "/home/me",
      parent: "/home",
      entries: [{ name: "code", path: `${path ?? "/home/me"}/code` }],
    }));
  });

  const setup = () => {
    const onAdded = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <TooltipProvider>
        <AddProjectDialog open onOpenChange={onOpenChange} onAdded={onAdded} />
      </TooltipProvider>,
    );
    return { onAdded, onOpenChange };
  };

  it("starts in the home folder and selects folders from the browser", async () => {
    setup();
    const field = (await screen.findByLabelText("Folder")) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("/home/me"));
    fireEvent.click(await screen.findByRole("option", { name: "code" }));
    expect(field.value).toBe("/home/me/code");
    fireEvent.dblClick(screen.getByRole("option", { name: "code" }));
    await waitFor(() => expect(mocked.listDirectory).toHaveBeenLastCalledWith("/home/me/code"));
  });

  it("blocks relative paths", async () => {
    setup();
    const field = (await screen.findByLabelText("Folder")) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("/home/me"));
    fireEvent.input(field, { target: { value: "relative/path" } });
    leave(field);
    expect(screen.getByRole("alert").textContent).toMatch(/absolute/);
    expect((screen.getByRole("button", { name: "Add Project" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("creates the project and reports its id", async () => {
    mocked.createProject.mockResolvedValue(makeProject({ id: "new", path: "/x/y" }));
    const { onAdded } = setup();
    const field = (await screen.findByLabelText("Folder")) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("/home/me"));
    fireEvent.input(field, { target: { value: "~/y" } });
    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Why" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Project" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("new"));
    expect(mocked.createProject).toHaveBeenCalledWith({ path: "~/y", name: "Why" });
    expect(projects.value.map((p) => p.id)).toEqual(["new"]);
  });

  it("shows server errors inline", async () => {
    mocked.createProject.mockRejectedValue(new Error("Folder does not exist"));
    setup();
    const field = (await screen.findByLabelText("Folder")) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("/home/me"));
    fireEvent.click(screen.getByRole("button", { name: "Add Project" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Folder does not exist");
  });
});
