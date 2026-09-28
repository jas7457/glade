import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { defaultSettings, type SlashCommand } from "@glade/protocol";

vi.mock("@/lib/api", () => ({ api: { updateSettings: vi.fn() } }));
vi.mock("@/lib/api-folder", () => ({ listFolderCommands: vi.fn() }));

import { api } from "@/lib/api";
import { listFolderCommands } from "@/lib/api-folder";
import { projects, settings } from "@/state/store";
import { isSlashCommandHidden, setSlashCommandsHidden, slashCommandKey } from "@/state/slash-visibility";
import { makeProject } from "@/test/fixtures";
import { TooltipProvider } from "@/ui";
import { CommandSettings } from "./CommandSettings";
import { listSlashCommands } from "./slash-command-list";

const cmd = (source: SlashCommand["source"], name: string, description?: string): SlashCommand => ({ source, name, description });

describe("slash visibility helpers", () => {
  it("keys commands by source and name and checks the hidden list", () => {
    expect(slashCommandKey(cmd("skill", "skill:web-design"))).toBe("skill:skill:web-design");
    const s = { ...defaultSettings(), slashCommands: { hidden: ["builtin:compact", "unknown:thing"] } };
    expect(isSlashCommandHidden(s, cmd("builtin", "compact"))).toBe(true);
    expect(isSlashCommandHidden(s, cmd("extension", "compact"))).toBe(false);
    expect(isSlashCommandHidden(defaultSettings(), cmd("builtin", "compact"))).toBe(false);
    expect(isSlashCommandHidden({} as never, cmd("builtin", "compact"))).toBe(false); // settings from an older server
    expect(setSlashCommandsHidden(["a", "b"], ["b", "c"], true)).toEqual(["a", "b", "c"]);
    expect(setSlashCommandsHidden(["a", "b"], ["b"], false)).toEqual(["a"]);
  });

  it("lists built-ins plus the union of folder commands, marking project-only ones", () => {
    const groups = listSlashCommands(
      [cmd("builtin", "new"), cmd("builtin", "compact")],
      [
        { projectName: null, commands: [cmd("extension", "powerline"), cmd("prompt", "compact")] },
        { projectName: "shop", commands: [cmd("extension", "powerline"), cmd("skill", "skill:deploy")] },
        { projectName: "app", commands: [cmd("skill", "skill:deploy"), cmd("prompt", "review")] },
      ],
    );
    expect(groups.map((g) => [g.label, g.commands.map((c) => [c.command.name, c.projects])])).toEqual([
      ["Built-in", [["compact", null], ["new", null]]],
      ["Extensions", [["powerline", null]]],
      ["Skills", [["skill:deploy", ["app", "shop"]]]],
      ["Prompts", [["review", ["app"]]]], // the "compact" prompt is shadowed by the built-in
    ]);
    expect(listSlashCommands([cmd("builtin", "new", "Start over")], [], "over").map((g) => g.commands.length)).toEqual([1]);
  });
});

describe("Settings → Slash Commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.value = defaultSettings();
    projects.value = [makeProject({ id: "p1", name: "shop", sortOrder: 0 })];
    vi.mocked(api.updateSettings).mockImplementation(async () => settings.value);
    vi.mocked(listFolderCommands).mockImplementation(async (projectId) =>
      projectId === null ? [cmd("extension", "powerline", "Status line")] : [cmd("extension", "powerline"), cmd("skill", "skill:deploy")],
    );
  });

  it("toggles single commands and whole groups", async () => {
    render(
      <TooltipProvider>
        <CommandSettings />
      </TooltipProvider>,
    );
    await waitFor(() => expect(screen.getByRole("switch", { name: "Show /skill:deploy" })).toBeTruthy());
    expect(listFolderCommands).toHaveBeenCalledWith(null, false, undefined);
    expect(listFolderCommands).toHaveBeenCalledWith("p1", false, undefined);
    expect(screen.getByText("Only in shop")).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Show /powerline" }));
    expect(api.updateSettings).toHaveBeenLastCalledWith({ slashCommands: { hidden: ["extension:powerline"] } });
    expect(screen.getByRole("switch", { name: "Show /powerline" }).getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Hide all Built-in" }));
    expect(settings.value.slashCommands.hidden).toContain("builtin:compact");
    fireEvent.click(screen.getByRole("button", { name: "Show all Extensions" }));
    expect(settings.value.slashCommands.hidden).not.toContain("extension:powerline");

    fireEvent.input(screen.getByRole("textbox", { name: "Filter commands" }), { target: { value: "deploy" } });
    expect(screen.getAllByRole("switch").map((s) => s.getAttribute("aria-label"))).toEqual(["Show /skill:deploy"]);
    expect(within(document.body).queryByText("Built-in")).toBeNull();
  });
});
