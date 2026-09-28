/** FolderBrowser (I-124): navigation, keyboard, autocomplete, New Folder, errors. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import type { FsBrowseEntry, FsBrowseResult } from "@glade/protocol";
import { baseName, crumbsFor, FolderBrowser, matchPrefix, splitTyped } from "./FolderBrowser";
import { TooltipProvider } from "./Tooltip";

const HOME = "/Users/me";

/** A fake host: folder path → child names ("+" suffix = git repo, leading "." = hidden). */
let tree: Record<string, string[]>;

const entry = (dir: string, raw: string): FsBrowseEntry => {
  const name = raw.replace(/\+$/, "");
  return { name, path: `${dir === "/" ? "" : dir}/${name}`, isGitRepo: raw.endsWith("+"), hidden: name.startsWith(".") };
};

const browse = vi.fn(async (input: string, { hidden }: { hidden: boolean }): Promise<FsBrowseResult> => {
  const path = input === "~" || input === "" ? HOME : input.replace(/^~(?=\/)/, HOME).replace(/\/+$/, "") || "/";
  if (!path.startsWith(HOME)) throw new Error("Browsing is limited to your home folder and /Volumes");
  const parent = path === HOME ? null : path.slice(0, path.lastIndexOf("/")) || "/";
  const children = tree[path];
  if (!children) return { path, parent, entries: [], isGitRepo: false, error: "This folder doesn't exist." };
  const entries = children.map((c) => entry(path, c)).filter((e) => hidden || !e.hidden);
  const self = tree[parent ?? ""]?.includes(`${baseName(path)}+`) ?? false;
  return { path, parent, entries, isGitRepo: self };
});
const mkdir = vi.fn(async (path: string): Promise<FsBrowseEntry> => {
  const dir = path.slice(0, path.lastIndexOf("/"));
  const name = path.slice(dir.length + 1);
  if (tree[dir]!.includes(name)) throw new Error(`“${name}” already exists`);
  tree[dir] = [...tree[dir]!, name].sort();
  tree[path] = [];
  return entry(dir, name);
});

beforeEach(() => {
  vi.clearAllMocks();
  tree = {
    [HOME]: [".config", "Code", "Documents"],
    [`${HOME}/Code`]: ["alpha+", "beta", "gamma+"],
    [`${HOME}/Code/alpha`]: ["src"],
    [`${HOME}/Documents`]: [],
    [`${HOME}/.config`]: [],
  };
});

const setup = (props: Partial<Parameters<typeof FolderBrowser>[0]> = {}) => {
  const onChoose = vi.fn();
  render(
    <TooltipProvider>
      <FolderBrowser browse={browse} mkdir={mkdir} onChoose={onChoose} {...props} />
    </TooltipProvider>,
  );
  return { onChoose };
};
const list = () => screen.getByRole("listbox", { name: /^Folders/ });
const rows = () => screen.queryAllByRole("option").filter((o) => list().contains(o));
const rowNames = () => rows().map((r) => r.textContent);
const opened = (name: string) => waitFor(() => expect(screen.getByRole("button", { current: "location" }).textContent).toBe(name));
const field = () => screen.getByLabelText("Folder path") as HTMLInputElement;
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(el, { key: k, ...init });

describe("helpers", () => {
  it("splitTyped", () => {
    expect(splitTyped("~/code/gl")).toEqual({ dir: "~/code", prefix: "gl" });
    expect(splitTyped("/Users/")).toEqual({ dir: "/Users", prefix: "" });
    expect(splitTyped("/Us")).toEqual({ dir: "/", prefix: "Us" });
    expect(splitTyped("~")).toEqual({ dir: "~", prefix: "" });
    expect(splitTyped("code")).toBeNull();
  });
  it("matchPrefix is case-insensitive and hides dot folders unless typed", () => {
    const es = [entry("/x", ".git"), entry("/x", "Glade"), entry("/x", "go")];
    expect(matchPrefix(es, "g").map((e) => e.name)).toEqual(["Glade", "go"]);
    expect(matchPrefix(es, "GL").map((e) => e.name)).toEqual(["Glade"]);
    expect(matchPrefix(es, ".").map((e) => e.name)).toEqual([".git"]);
  });
  it("crumbsFor starts at the deepest known root", () => {
    expect(crumbsFor("/Users/me/code/app", ["/Users/me", "/Volumes"])).toEqual([
      { label: "me", path: "/Users/me" },
      { label: "code", path: "/Users/me/code" },
      { label: "app", path: "/Users/me/code/app" },
    ]);
    expect(crumbsFor("/Volumes/Disk", ["/Users/me", "/Volumes"]).map((c) => c.label)).toEqual(["Volumes", "Disk"]);
    expect(crumbsFor("/tmp/x", []).map((c) => c.label)).toEqual(["/", "tmp", "x"]);
  });
});

describe("FolderBrowser", () => {
  it("opens home, lists folders with git markers, and hides dot folders until asked", async () => {
    setup();
    await opened("Home");
    expect(rowNames()).toEqual(["Code", "Documents"]);
    expect(field().value).toBe(HOME);
    fireEvent.click(screen.getByLabelText("Show hidden folders"));
    await waitFor(() => expect(rowNames()).toEqual([".config", "Code", "Documents"]));
    expect(browse).toHaveBeenLastCalledWith(HOME, { hidden: true });
  });

  it("navigates with the keyboard: ↓ selects, Enter opens, ⌘↑ goes up and reselects", async () => {
    setup();
    await opened("Home");
    key(list(), "ArrowDown");
    expect(rows()[0]!.getAttribute("aria-selected")).toBe("true");
    key(list(), "Enter");
    await opened("Code");
    expect(rowNames()).toEqual(["alphagit", "beta", "gammagit"]);
    key(list(), "ArrowUp", { metaKey: true });
    await opened("Home");
    expect(rows().find((r) => r.getAttribute("aria-selected") === "true")?.textContent).toBe("Code");
  });

  it("chooses the selected folder with ⌘Enter, or the open folder with Choose", async () => {
    const { onChoose } = setup({ initialPath: `${HOME}/Code` });
    await opened("Code");
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    expect(onChoose).toHaveBeenLastCalledWith(`${HOME}/Code`);
    key(list(), "g"); // type-ahead
    key(list(), "Enter", { metaKey: true });
    expect(onChoose).toHaveBeenLastCalledWith(`${HOME}/Code/gamma`);
  });

  it("opens folders on double-click and via breadcrumbs and shortcuts", async () => {
    setup({ recent: [`${HOME}/Code/alpha`] });
    await opened("Home");
    fireEvent.dblClick(rows()[0]!);
    await opened("Code");
    fireEvent.click(screen.getByRole("button", { name: "alpha" }));
    await opened("alpha");
    expect(screen.getByText("Git repository")).toBeTruthy();
    fireEvent.click(screen.getByRole("navigation").querySelector("button")!);
    await opened("Home");
  });

  it("autocompletes child folders as you type; Tab completes, Enter opens", async () => {
    setup();
    await opened("Home");
    fireEvent.input(field(), { target: { value: `${HOME}/Code/` } });
    const suggest = await screen.findByRole("listbox", { name: "Matching folders" });
    await waitFor(() => expect(suggest.textContent).toBe("alphabetagamma"));
    fireEvent.input(field(), { target: { value: `${HOME}/Code/G` } });
    await waitFor(() => expect(screen.getByRole("listbox", { name: "Matching folders" }).textContent).toBe("gamma"));
    key(field(), "Tab");
    expect(field().value).toBe(`${HOME}/Code/gamma/`);
    key(field(), "Enter");
    await opened("gamma");
  });

  it("shows unreadable folders and refused paths as errors", async () => {
    setup();
    await opened("Home");
    fireEvent.input(field(), { target: { value: `${HOME}/missing` } });
    key(field(), "Enter");
    await opened("missing");
    expect(list().textContent).toContain("doesn't exist");
    fireEvent.input(field(), { target: { value: "/etc" } });
    key(field(), "Enter");
    expect((await screen.findByRole("alert")).textContent).toMatch(/limited/);
    await opened("missing"); // the previous listing stays
  });

  it("creates a folder inline and selects it", async () => {
    setup({ initialPath: `${HOME}/Code` });
    await opened("Code");
    fireEvent.click(screen.getByRole("button", { name: /New Folder/ }));
    const name = screen.getByLabelText("New folder name") as HTMLInputElement;
    fireEvent.input(name, { target: { value: "beta" } });
    key(name, "Enter");
    expect((await screen.findByRole("alert")).textContent).toContain("already exists");
    fireEvent.input(name, { target: { value: "delta" } });
    await act(async () => void key(name, "Enter"));
    await waitFor(() => expect(rowNames()).toEqual(["alphagit", "beta", "delta", "gammagit"]));
    expect(mkdir).toHaveBeenLastCalledWith(`${HOME}/Code/delta`);
    expect(rows().find((r) => r.getAttribute("aria-selected") === "true")?.textContent).toBe("delta");
  });
});
