import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/preact";

vi.mock("@/lib/api", () => ({ api: { createProject: vi.fn() } }));
vi.mock("@/lib/native", () => ({ pickFolder: vi.fn() }));

import { api } from "@/lib/api";
import { pickFolder } from "@/lib/native";
import { TooltipProvider } from "@/ui";
import { projects } from "@/state/store";
import { makeProject } from "@/test/fixtures";
import { AddProjectDialog } from "./AddProjectDialog";
import { folderName, nameAfterPick, validateProjectPath } from "./validation";

const mocked = vi.mocked(api);
const pick = vi.mocked(pickFolder);

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
  it("folderName", () => {
    expect(folderName("/a/b/")).toBe("b");
    expect(folderName("/")).toBe("/");
  });
  it("nameAfterPick fills empty or auto-filled names only", () => {
    expect(nameAfterPick("", null, "/x/app")).toBe("app");
    expect(nameAfterPick("  ", null, "/x/app")).toBe("app");
    expect(nameAfterPick("app", "app", "/x/other")).toBe("other");
    expect(nameAfterPick("Mine", null, "/x/app")).toBe("Mine");
    expect(nameAfterPick("Mine", "app", "/x/other")).toBe("Mine");
  });
});

describe("AddProjectDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projects.value = [];
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
  const nameField = () => screen.getByLabelText("Project name") as HTMLInputElement;
  const createButton = () => screen.getByRole("button", { name: "Create project" }) as HTMLButtonElement;
  const add = async () => {
    fireEvent.click(screen.getByRole("button", { name: /Add/ }));
    await waitFor(() => expect(pick).toHaveBeenCalled());
  };

  it("disables Create until a folder is chosen, then fills the empty name", async () => {
    pick.mockResolvedValue({ path: "/Users/me/code/app" });
    setup();
    expect(screen.getByRole("heading", { name: "Create project" })).toBeTruthy();
    expect(createButton().disabled).toBe(true);
    await add();
    expect(await screen.findByText("/Users/me/code/app")).toBeTruthy();
    expect(nameField().value).toBe("app");
    expect(createButton().disabled).toBe(false);
  });

  it("never overwrites a name the user typed", async () => {
    pick.mockResolvedValue({ path: "/Users/me/code/app" });
    setup();
    fireEvent.input(nameField(), { target: { value: "My App" } });
    await add();
    await screen.findByText("/Users/me/code/app");
    expect(nameField().value).toBe("My App");
  });

  it("updates an auto-filled name when the folder is changed", async () => {
    pick.mockResolvedValueOnce({ path: "/x/one" }).mockResolvedValueOnce({ path: "/x/two" });
    setup();
    await add();
    await waitFor(() => expect(nameField().value).toBe("one"));
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    await screen.findByText("/x/two");
    expect(nameField().value).toBe("two");
    expect(pick).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: "/x/one" }));
  });

  it("leaves everything unchanged when the picker is cancelled", async () => {
    pick.mockResolvedValueOnce({ path: "/x/one" }).mockResolvedValueOnce({ cancelled: true });
    setup();
    await add();
    await screen.findByText("/x/one");
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    await waitFor(() => expect(pick).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Change…" })).toBeTruthy());
    expect(screen.getByText("/x/one")).toBeTruthy();
    expect(nameField().value).toBe("one");
    expect(createButton().disabled).toBe(false);
  });

  it("removing the folder clears an auto-filled name and disables Create", async () => {
    pick.mockResolvedValue({ path: "/x/one" });
    setup();
    await add();
    await screen.findByText("/x/one");
    fireEvent.click(screen.getByRole("button", { name: "Remove Folder" }));
    expect(screen.queryByText("/x/one")).toBeNull();
    expect(nameField().value).toBe("");
    expect(createButton().disabled).toBe(true);
  });

  it("creates the project and reports its id", async () => {
    pick.mockResolvedValue({ path: "/x/y" });
    mocked.createProject.mockResolvedValue(makeProject({ id: "new", path: "/x/y" }));
    const { onAdded } = setup();
    await add();
    await screen.findByText("/x/y");
    fireEvent.input(nameField(), { target: { value: "Why" } });
    fireEvent.click(createButton());
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("new"));
    expect(mocked.createProject).toHaveBeenCalledWith({ path: "/x/y", name: "Why" });
    expect(projects.value.map((p) => p.id)).toEqual(["new"]);
  });

  it("shows picker and server errors inline", async () => {
    pick.mockRejectedValueOnce(new Error("Folder picker failed: boom"));
    setup();
    await add();
    expect((await screen.findByRole("alert")).textContent).toContain("boom");

    pick.mockResolvedValueOnce({ path: "/x/gone" });
    mocked.createProject.mockRejectedValue(new Error("Folder does not exist"));
    fireEvent.click(screen.getByRole("button", { name: /Add/ }));
    await screen.findByText("/x/gone");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(createButton());
    expect((await screen.findByRole("alert")).textContent).toContain("Folder does not exist");
  });

  it("falls back to a path field when no native picker is available", async () => {
    pick.mockResolvedValue({ unavailable: true });
    mocked.createProject.mockResolvedValue(makeProject({ id: "p", path: "/x/typed" }));
    const { onAdded } = setup();
    await add();
    const field = (await screen.findByLabelText("Source folder")) as HTMLInputElement;
    expect(field.tagName).toBe("INPUT");
    fireEvent.input(field, { target: { value: "relative" } });
    leave(field);
    expect(screen.getByRole("alert").textContent).toMatch(/absolute/);
    expect(createButton().disabled).toBe(true);
    fireEvent.input(field, { target: { value: "~/typed" } });
    fireEvent.click(createButton());
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("p"));
    expect(mocked.createProject).toHaveBeenCalledWith({ path: "~/typed" });
  });
});
