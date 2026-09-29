import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import type { FsBrowseResult } from "@glade/protocol";

vi.mock("@glade/app-core/lib/api", () => ({ api: { createProject: vi.fn() }, request: vi.fn() }));
vi.mock("@/lib/native", () => ({ pickFolder: vi.fn() }));

import { api, request as localRequest } from "@glade/app-core/lib/api";
import { pickFolder } from "@/lib/native";
import { TooltipProvider } from "@glade/app-core/ui";
import { projects } from "@glade/app-core/state/store";
import { makeProject } from "@glade/app-core/test/fixtures";
import { fakeEnv, resetEnvironmentsForTest, useEnvironments } from "@glade/app-core/test/env-fixtures";
import { AddProjectDialog } from "./AddProjectDialog";
import type { ProjectFolderSource } from "./folder-source";
import { folderName, nameAfterPick, validateProjectPath } from "./validation";

const mocked = vi.mocked(api);
const pick = vi.mocked(pickFolder);

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
  const HOME = "/Users/me";
  const dirs: Record<string, string[]> = { [HOME]: ["code"], [`${HOME}/code`]: ["app", "other"], [`${HOME}/code/app`]: [], [`${HOME}/code/other`]: [] };
  const folders: ProjectFolderSource = {
    browse: vi.fn(async (input: string): Promise<FsBrowseResult> => {
      const path = input === "~" ? HOME : input;
      return {
        path,
        parent: path === HOME ? null : path.slice(0, path.lastIndexOf("/")),
        entries: (dirs[path] ?? []).map((name) => ({ name, path: `${path}/${name}`, isGitRepo: name === "app", hidden: false })),
        isGitRepo: path.endsWith("/app"),
      };
    }),
    mkdir: vi.fn(),
    nativePicker: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    projects.value = [];
  });

  const setup = (source: ProjectFolderSource = folders) => {
    const onAdded = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <TooltipProvider>
        <AddProjectDialog open onOpenChange={onOpenChange} onAdded={onAdded} folders={source} />
      </TooltipProvider>,
    );
    return { onAdded, onOpenChange };
  };
  const nameField = () => screen.getByLabelText("Project name") as HTMLInputElement;
  const createButton = () => screen.getByRole("button", { name: "Create project" }) as HTMLButtonElement;
  const option = (name: string) => screen.findByRole("option", { name: new RegExp(`^${name}`) });
  /** Browse to ~/code and choose `name` there. */
  const browseTo = async (name: string) => {
    fireEvent.dblClick(await option("code"));
    fireEvent.mouseDown(await option(name));
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    await screen.findByText(`${HOME}/code/${name}`);
  };

  it("shows the folder browser until a folder is chosen, then fills the empty name", async () => {
    setup();
    expect(screen.getByRole("heading", { name: "Create project" })).toBeTruthy();
    expect(createButton().disabled).toBe(true);
    await browseTo("app");
    expect(folders.browse).toHaveBeenCalledWith("~", { hidden: false });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(nameField().value).toBe("app");
    expect(createButton().disabled).toBe(false);
  });

  it("never overwrites a name the user typed", async () => {
    setup();
    fireEvent.input(nameField(), { target: { value: "My App" } });
    await browseTo("app");
    expect(nameField().value).toBe("My App");
  });

  it("updates an auto-filled name when the folder is changed; Back keeps the old one", async () => {
    setup();
    await browseTo("app");
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    await waitFor(() => expect(folders.browse).toHaveBeenLastCalledWith(`${HOME}/code/app`, { hidden: false }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText(`${HOME}/code/app`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    fireEvent.click(await screen.findByRole("button", { name: /Enclosing Folder/ }));
    fireEvent.mouseDown(await option("other"));
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    await screen.findByText(`${HOME}/code/other`);
    expect(nameField().value).toBe("other");
  });

  it("removing the folder clears an auto-filled name and shows the browser again", async () => {
    setup();
    await browseTo("app");
    fireEvent.click(screen.getByRole("button", { name: "Remove Folder" }));
    expect(nameField().value).toBe("");
    expect(createButton().disabled).toBe(true);
    expect(await screen.findByRole("listbox")).toBeTruthy();
  });

  it("creates the project and reports its id", async () => {
    mocked.createProject.mockResolvedValue(makeProject({ id: "new", path: `${HOME}/code/app` }));
    const { onAdded } = setup();
    await browseTo("app");
    fireEvent.input(nameField(), { target: { value: "Why" } });
    fireEvent.click(createButton());
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("new"));
    expect(mocked.createProject).toHaveBeenCalledWith({ path: `${HOME}/code/app`, name: "Why" });
    expect(projects.value.map((p) => p.id)).toEqual(["new"]);
  });

  it("offers Choose in Finder… for this Mac and uses its result", async () => {
    pick.mockResolvedValue({ path: "/x/picked" });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Choose in Finder…" }));
    await screen.findByText("/x/picked");
    expect(nameField().value).toBe("picked");
  });

  it("hides Choose in Finder… for other environments and when no native picker exists", async () => {
    setup({ ...folders, nativePicker: false });
    expect(screen.queryByRole("button", { name: "Choose in Finder…" })).toBeNull();
    cleanup();
    pick.mockResolvedValue({ unavailable: true });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Choose in Finder…" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Choose in Finder…" })).toBeNull());
  });

  it("shows picker and server errors inline", async () => {
    pick.mockRejectedValueOnce(new Error("Folder picker failed: boom"));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Choose in Finder…" }));
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    mocked.createProject.mockRejectedValue(new Error("Folder does not exist"));
    await browseTo("app");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(createButton());
    expect((await screen.findByRole("alert")).textContent).toContain("Folder does not exist");
  });
});

/**
 * I-139: picking another device in the sheet's "Device" select kept closing the whole sheet
 * (the pick in the portaled menu counted as a click outside the dialog).
 */
describe("AddProjectDialog with several devices", () => {
  const listing = (path: string, names: string[]): FsBrowseResult => ({
    path,
    parent: null,
    entries: names.map((name) => ({ name, path: `${path}/${name}`, isGitRepo: false, hidden: false })),
    isGitRepo: false,
  });
  const remoteRequest = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    projects.value = [];
    vi.mocked(localRequest).mockResolvedValue(listing("/Users/me", ["local-only"]));
    remoteRequest.mockResolvedValue(listing("/Users/air", ["remote-only"]));
    useEnvironments(fakeEnv({ id: "B", name: "MacBook Air", api: { request: remoteRequest } }));
  });
  afterEach(() => {
    cleanup();
    resetEnvironmentsForTest();
  });

  const setup = () => {
    const onOpenChange = vi.fn();
    render(
      <TooltipProvider>
        <AddProjectDialog open onOpenChange={onOpenChange} />
      </TooltipProvider>,
    );
    return { onOpenChange };
  };
  /** Pick a device with the mouse, the way the user does. */
  const pickDevice = async (name: string) => {
    // Radix registers its outside-pointer listeners a tick after the layers mount.
    await new Promise((r) => setTimeout(r, 50));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Device" }), { button: 0, pointerType: "mouse" });
    const item = await screen.findByRole("menuitemradio", { name, hidden: true });
    await new Promise((r) => setTimeout(r, 50));
    fireEvent.pointerDown(item, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(item, { button: 0, pointerType: "mouse" });
    fireEvent.click(item);
  };

  it("lists This Mac and the device's name under Device", async () => {
    setup();
    expect(screen.getByText("Device")).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Device" }), { button: 0, pointerType: "mouse" });
    const items = await screen.findAllByRole("menuitemradio", { hidden: true });
    expect(items.map((i) => i.textContent)).toEqual(["This Mac", "MacBook Air"]);
  });

  it("stays open when another device is picked and browses that device's folders", async () => {
    const { onOpenChange } = setup();
    expect(await screen.findByRole("option", { name: /^local-only/ })).toBeTruthy();
    await pickDevice("MacBook Air");
    expect(await screen.findByRole("option", { name: /^remote-only/ })).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("heading", { name: "Create project" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Device" }).textContent).toContain("MacBook Air");
    expect(remoteRequest).toHaveBeenCalledWith("GET", "/fs/browse?path=%7E");
  });

  it("shows a failing remote browse inside the folder browser, not by closing", async () => {
    remoteRequest.mockRejectedValue(new Error("MacBook Air can't be reached"));
    const { onOpenChange } = setup();
    await pickDevice("MacBook Air");
    expect((await screen.findByRole("alert")).textContent).toContain("can't be reached");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("heading", { name: "Create project" })).toBeTruthy();
  });
});
