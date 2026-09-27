/** Settings → Prompts (I-098): list, add, edit, reorder and delete saved prompts. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { MemoryRouter, Route, Routes } from "react-router";
import { defaultSettings, type SavedPrompt } from "@glade/protocol";

vi.mock("@/lib/api", () => ({ api: { updateSettings: vi.fn() } }));

import { api } from "@/lib/api";
import { ConfirmHost, TooltipProvider } from "@/ui";
import { projects, settings } from "@/state/store";
import { SettingsRoute } from "./SettingsView";
import { groupPrompts } from "./PromptSettings";

const mocked = vi.mocked(api);

const PROMPTS: SavedPrompt[] = [
  { id: "a", name: "Review diff", description: "Careful review", body: "Review this diff.", projectId: null },
  { id: "b", name: "Explain", body: "Explain it", projectId: null },
  { id: "c", name: "Deploy", body: "Deploy checklist", projectId: "p1" },
];

function renderPrompts() {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={["/settings/prompts"]}>
        <Routes>
          <Route path="/settings/:section" element={<SettingsRoute />} />
        </Routes>
      </MemoryRouter>
      <ConfirmHost />
    </TooltipProvider>,
  );
}

const ids = () => settings.value.prompts.map((p) => p.id);

beforeEach(() => {
  vi.clearAllMocks();
  settings.value = { ...defaultSettings(), prompts: PROMPTS };
  projects.value = [
    { id: "p1", name: "glade", path: "/p1", sortOrder: 0, createdAt: 0, lastActivityAt: 0 },
    { id: "p2", name: "empty", path: "/p2", sortOrder: 1, createdAt: 0, lastActivityAt: 0 },
  ];
  // The server echoes the patched settings.
  mocked.updateSettings.mockImplementation(async () => settings.value);
});

describe("prompt settings", () => {
  it("groups global prompts first, then projects that have prompts", () => {
    const groups = groupPrompts(PROMPTS, projects.value);
    expect(groups.map((g) => [g.title, g.prompts.map((p) => p.id)])).toEqual([
      ["All Chats", ["a", "b"]],
      ["glade", ["c"]],
    ]);
    expect(groupPrompts([], projects.value).map((g) => g.title)).toEqual(["All Chats"]);
  });

  it("lists prompts with their / names and previews", () => {
    renderPrompts();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Prompts");
    expect(screen.getByText("/review-diff")).toBeTruthy();
    expect(screen.getByText("Careful review")).toBeTruthy();
    expect(screen.getByText("Explain it")).toBeTruthy(); // no description: start of the text
    expect(screen.getByRole("heading", { name: "glade" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "empty" })).toBeNull();
  });

  it("adds a prompt", async () => {
    renderPrompts();
    fireEvent.click(screen.getByRole("button", { name: "New Prompt" }));
    const dialog = await screen.findByRole("dialog");
    const add = within(dialog).getByRole("button", { name: "Add prompt" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.input(within(dialog).getByLabelText("Name"), { target: { value: "Write tests" } });
    expect(within(dialog).getByText("/write-tests")).toBeTruthy();
    fireEvent.input(within(dialog).getByLabelText("Prompt"), { target: { value: "Write tests for @src/a.ts" } });
    fireEvent.click(add);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const added = settings.value.prompts.at(-1)!;
    expect(added).toMatchObject({ name: "Write tests", body: "Write tests for @src/a.ts", projectId: null });
    expect(added.id).toBeTruthy();
    expect(mocked.updateSettings).toHaveBeenCalledWith({ prompts: [...PROMPTS, added] });
  });

  it("adds to a project from its group", async () => {
    renderPrompts();
    fireEvent.click(screen.getByRole("button", { name: "Add prompt to glade" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.input(within(dialog).getByLabelText("Name"), { target: { value: "Release" } });
    fireEvent.input(within(dialog).getByLabelText("Prompt"), { target: { value: "Cut a release" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add prompt" }));
    await waitFor(() => expect(settings.value.prompts.at(-1)).toMatchObject({ name: "Release", projectId: "p1" }));
  });

  it("edits a prompt", async () => {
    renderPrompts();
    fireEvent.click(screen.getByRole("button", { name: "Edit Explain" }));
    const dialog = await screen.findByRole("dialog");
    const body = within(dialog).getByLabelText("Prompt") as HTMLTextAreaElement;
    expect(body.value).toBe("Explain it");
    fireEvent.input(body, { target: { value: "Explain it simply" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(settings.value.prompts.find((p) => p.id === "b")?.body).toBe("Explain it simply"));
    expect(ids()).toEqual(["a", "b", "c"]);
  });

  it("reorders within a group", async () => {
    renderPrompts();
    const down = screen.getAllByRole("button", { name: "Move down" }) as HTMLButtonElement[];
    expect(down.map((b) => b.disabled)).toEqual([false, true, true]); // last of each group can't move down
    fireEvent.click(down[0]!);
    await waitFor(() => expect(ids()).toEqual(["b", "a", "c"]));
  });

  it("deletes after confirming", async () => {
    renderPrompts();
    fireEvent.click(screen.getByRole("button", { name: "Delete Review diff" }));
    const alert = await screen.findByRole("alertdialog");
    fireEvent.click(within(alert).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(ids()).toEqual(["b", "c"]));
  });
});
