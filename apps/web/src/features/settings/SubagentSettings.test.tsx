/**
 * Settings → Sub-agents (I-218): the list (sources, switches, problems), the harness-first create
 * flow, the Read-only preset per harness, and Customize (a Glade file that extends the source).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { defaultSettings, emptyAgentDefFields, type AgentDef, type AgentDefFields, type HarnessCapabilities, type HarnessInfo } from "@glade/protocol";

vi.mock("@glade/app-core/lib/api", async (orig) => ({ ...(await orig<object>()), api: { updateSettings: vi.fn() } }));
vi.mock("@glade/app-core/lib/api-agent-defs", () => ({
  listAgentDefs: vi.fn(),
  saveAgentDef: vi.fn(),
  deleteAgentDef: vi.fn(),
  describeAgentDef: vi.fn(),
  getAgentDefTools: vi.fn(),
}));

import { api } from "@glade/app-core/lib/api";
import * as defsApi from "@glade/app-core/lib/api-agent-defs";
import { ConfirmHost, TooltipProvider } from "@glade/app-core/ui";
import { projects, settings } from "@glade/app-core/state/store";
import { harnesses } from "@glade/app-core/state/harnesses";
import { agentDefLists } from "@glade/app-core/state/agent-defs";
import { SettingsRoute } from "./SettingsView";
import { SettingsSubagentRoute } from "./SubagentEditor";
import { customizeDraft, harnessModelLine, isGladeTool, modelName, readOnlyPreset } from "./subagent-defs";

const mockedApi = vi.mocked(api);
const defs = vi.mocked(defsApi);

const CAPS = {} as HarnessCapabilities;
const HARNESSES: HarnessInfo[] = [
  { id: "pi", label: "pi", isDefault: true, capabilities: CAPS },
  { id: "claude", label: "Claude Code", isDefault: false, capabilities: CAPS },
  { id: "codex", label: "Codex", isDefault: false, capabilities: CAPS },
];

function fieldsOf(over: Partial<AgentDefFields>): AgentDefFields {
  return { ...emptyAgentDefFields("claude"), ...over };
}

function def(over: Partial<AgentDef> & { fields: AgentDefFields }): AgentDef {
  const source = over.source ?? "personal";
  return {
    id: `${source}:${over.fields.name}`,
    source,
    path: `~/agents/${over.fields.name}.md`,
    editable: source === "personal" || source === "project",
    effective: over.fields,
    base: null,
    enabled: true,
    available: true,
    problems: [],
    shadowedBy: null,
    ...over,
  };
}

const SCOUT = def({
  fields: fieldsOf({ name: "scout", description: "Fast read-only search.", nicknames: ["Brandon", "Bea"], color: "teal", icon: "search", prompt: "Trace it." }),
});
const REVIEWER_FIELDS = fieldsOf({ name: "reviewer", description: "Reviews diffs.", model: "haiku", prompt: "Review carefully.", tools: ["Read", "Grep"] });
const REVIEWER = def({ source: "claude", path: "~/.claude/agents/reviewer.md", fields: REVIEWER_FIELDS });
const BROKEN = def({
  source: "codex",
  path: "~/.codex/agents/fixer.toml",
  fields: fieldsOf({ name: "fixer", harness: "codex" }),
  available: false,
  problems: ["Codex is turned off"],
  shadowedBy: "personal:fixer",
});

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

function renderAt(path: string) {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings/:section" element={<SettingsRoute />} />
          <Route path="/settings/subagents/:mode/:key" element={<SettingsSubagentRoute />} />
        </Routes>
        <Where />
      </MemoryRouter>
      <ConfirmHost />
    </TooltipProvider>,
  );
}

const where = () => screen.getByTestId("where").textContent;

beforeEach(() => {
  vi.clearAllMocks();
  agentDefLists.value = {};
  settings.value = { ...defaultSettings(), agentDefs: { disabled: ["reviewer"], projects: { p1: { reviewer: true } } } };
  projects.value = [{ id: "p1", name: "glade", path: "/p1", sortOrder: 0, createdAt: 0, lastActivityAt: 0 }];
  harnesses.value = HARNESSES;
  mockedApi.updateSettings.mockImplementation(async () => settings.value);
  defs.listAgentDefs.mockResolvedValue([SCOUT, REVIEWER, BROKEN]);
  defs.saveAgentDef.mockImplementation(async (req) => def({ source: req.scope, fields: req.fields }));
  defs.getAgentDefTools.mockImplementation(async (harness) =>
    harness === "claude"
      ? { harness, tools: ["Read", "Grep", "Glob", "Bash", "Edit", "WebSearch", "mcp__glade__report_done", "report_done"], mcpServers: [], seenAt: 1 }
      : { harness, tools: [], mcpServers: [], seenAt: null },
  );
});

describe("Sub-agents list", () => {
  it("lists Glade's agents and discovered ones by source, with switches and problems", async () => {
    renderAt("/settings/subagents");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sub-agents");
    const scout = await screen.findByRole("button", { name: "scout" });
    const row = scout.parentElement!;
    expect(row.textContent).toContain("Brandon, Bea");
    expect(row.textContent).toContain("Claude Code · sub-agent model");
    expect(row.querySelector('[data-agent-icon="search"]')).not.toBeNull();
    expect(within(row).getByTitle("~/agents/scout.md").textContent).toBe("Glade");
    expect(screen.getByRole("heading", { name: "Claude Code" })).toBeTruthy();
    const reviewer = screen.getByRole("button", { name: "reviewer" }).parentElement!;
    expect(within(reviewer).getByTitle("~/.claude/agents/reviewer.md").textContent).toBe("Claude Code");
    // Switches: scout on, reviewer off everywhere.
    expect((within(row).getByRole("switch", { name: "Use scout" }) as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
    expect(within(reviewer).getByRole("switch", { name: "Use reviewer" }).getAttribute("aria-checked")).toBe("false");
    const fixer = screen.getByRole("button", { name: "fixer" }).parentElement!;
    expect(fixer.textContent).toContain("Can't be used: Codex is turned off");
    expect(fixer.textContent).toContain("Overridden by Glade · fixer");
    expect(defs.listAgentDefs).toHaveBeenCalledWith(null, expect.any(Function));
  });

  it("a project's view uses its overrides and writes the project's switch", async () => {
    renderAt("/settings/subagents?project=p1");
    const reviewer = (await screen.findByRole("button", { name: "reviewer" })).parentElement!;
    expect(defs.listAgentDefs).toHaveBeenCalledWith("p1", expect.any(Function));
    const sw = within(reviewer).getByRole("switch", { name: "Use reviewer" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    await waitFor(() => expect(mockedApi.updateSettings).toHaveBeenCalledWith({ agentDefs: { projects: { p1: { reviewer: false } } } }));
  });

  it("a project's own setting says so and goes back to the all-chats switch", async () => {
    renderAt("/settings/subagents?project=p1");
    const reviewer = (await screen.findByRole("button", { name: "reviewer" })).parentElement!;
    expect(reviewer.textContent).toContain("Set for this project (all chats: off)");
    const scout = screen.getByRole("button", { name: "scout" }).parentElement!;
    expect(within(scout).queryByRole("button", { name: /Use the setting for all chats/ })).toBeNull();
    fireEvent.click(within(reviewer).getByRole("button", { name: "Use the setting for all chats (off)" }));
    await waitFor(() => expect(mockedApi.updateSettings).toHaveBeenCalledWith({ agentDefs: { projects: { p1: { reviewer: null } } } }));
    // Optimistically back on the global switch (off) before the server's pruned settings arrive.
    expect(within(reviewer).getByRole("switch", { name: "Use reviewer" }).getAttribute("aria-checked")).toBe("false");
  });

  it("the global switch adds to or removes from the disabled list", async () => {
    renderAt("/settings/subagents");
    const scout = (await screen.findByRole("button", { name: "scout" })).parentElement!;
    fireEvent.click(within(scout).getByRole("switch", { name: "Use scout" }));
    await waitFor(() => expect(mockedApi.updateSettings).toHaveBeenCalledWith({ agentDefs: { disabled: ["reviewer", "scout"] } }));
  });
});

describe("creating an agent", () => {
  it("asks for the harness first, then saves the editor's fields", async () => {
    renderAt("/settings/subagents");
    await screen.findByRole("button", { name: "scout" });
    fireEvent.keyDown(screen.getByRole("button", { name: /New Agent/ }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Claude Code" }));
    await waitFor(() => expect(where()).toBe("/settings/subagents/new/claude"));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("New Agent");
    expect(screen.getByRole("heading", { name: "Claude Code settings" })).toBeTruthy();
    const create = screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Code Scout" } });
    expect(screen.getByText("code-scout")).toBeTruthy();
    fireEvent.input(screen.getByLabelText("Prompt"), { target: { value: "Find things." } });
    fireEvent.input(screen.getByLabelText("Add to Nicknames"), { target: { value: "Brandon" } });
    fireEvent.keyDown(screen.getByLabelText("Add to Nicknames"), { key: "Enter" });
    fireEvent.click(screen.getByRole("radio", { name: "Teal" }));
    fireEvent.click(screen.getByRole("radio", { name: "Search" }));
    fireEvent.click(create);
    await waitFor(() => expect(defs.saveAgentDef).toHaveBeenCalled());
    const [req] = defs.saveAgentDef.mock.calls[0]!;
    expect(req).toEqual({
      scope: "personal",
      projectId: null,
      fields: { ...emptyAgentDefFields("claude"), name: "code-scout", prompt: "Find things.", nicknames: ["Brandon"], color: "teal", icon: "search" },
    });
    await waitFor(() => expect(where()).toBe("/settings/subagents"));
  });

  it("writes a description from the prompt", async () => {
    defs.describeAgentDef.mockResolvedValue("Use when you need X. Not for Y.");
    renderAt("/settings/subagents/new/pi");
    const write = screen.getByRole("button", { name: "Write description for me" }) as HTMLButtonElement;
    expect(write.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "x" } });
    fireEvent.input(screen.getByLabelText("Prompt"), { target: { value: "Do X." } });
    fireEvent.click(write);
    await waitFor(() => expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("Use when you need X. Not for Y."));
    expect(defs.describeAgentDef).toHaveBeenCalledWith({ name: "x", harness: "pi", prompt: "Do X." }, expect.any(Function));
  });

  it("shows the server's error inline", async () => {
    defs.saveAgentDef.mockRejectedValue(new Error("An agent named scout already exists"));
    renderAt("/settings/subagents/new/codex");
    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "scout" } });
    fireEvent.input(screen.getByLabelText("Prompt"), { target: { value: "p" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    expect((await screen.findByRole("alert")).textContent).toBe("An agent named scout already exists");
  });
});

describe("Read-only preset", () => {
  it("fills each harness's own settings", () => {
    expect(readOnlyPreset("pi", [])).toEqual({ tools: ["read", "grep", "find", "ls"] });
    expect(readOnlyPreset("claude", ["Read", "WebSearch"])).toEqual({ tools: ["Read", "Grep", "Glob", "WebSearch"], disallowedTools: ["Edit", "MultiEdit", "Write", "NotebookEdit"] });
    expect(readOnlyPreset("codex", [])).toEqual({ sandbox: "read-only" });
    expect(readOnlyPreset("inherit", [])).toBeNull();
  });

  it("Claude Code: checks the read tools from the live list and denies the editing ones", async () => {
    renderAt("/settings/subagents/new/claude");
    await waitFor(() => expect(defs.getAgentDefTools).toHaveBeenCalledWith("claude", null, expect.any(Function)));
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: "Read only" }));
    const tools = screen.getByRole("group", { name: "Tools" });
    await waitFor(() => expect((within(tools).getByRole("checkbox", { name: "Read" }) as HTMLInputElement).checked).toBe(true));
    expect((within(tools).getByRole("checkbox", { name: "WebSearch" }) as HTMLInputElement).checked).toBe(true);
    expect((within(tools).getByRole("checkbox", { name: "Bash" }) as HTMLInputElement).checked).toBe(false);
    const denied = screen.getByRole("group", { name: "Denied tools" });
    // Edit is in the live list; MultiEdit isn't: still checked, marked unavailable.
    expect((within(denied).getByRole("checkbox", { name: "Edit" }) as HTMLInputElement).checked).toBe(true);
    expect((within(denied).getByRole("checkbox", { name: "MultiEdit" }) as HTMLInputElement).checked).toBe(true);
    expect(within(denied).getAllByText("not available right now").length).toBe(3);
    expect(screen.getByText(/Shell commands still ask for permission/)).toBeTruthy();
    // Glade's own tools are always there: not offered.
    expect(within(tools).queryByRole("checkbox", { name: "mcp__glade__report_done" })).toBeNull();
    expect(within(tools).queryByRole("checkbox", { name: "report_done" })).toBeNull();
  });

  it("pi: says how to load its tools when none were seen yet", async () => {
    renderAt("/settings/subagents/new/pi");
    fireEvent.click(screen.getByRole("button", { name: "Read only" }));
    const tools = screen.getByRole("group", { name: "Tools" });
    expect(await within(tools).findByText("Start a chat with pi to load its tools.")).toBeTruthy();
    expect((within(tools).getByRole("checkbox", { name: "grep" }) as HTMLInputElement).checked).toBe(true);
  });

  it("Codex: the read-only sandbox", async () => {
    renderAt("/settings/subagents/new/codex");
    fireEvent.click(screen.getByRole("button", { name: "Read only" }));
    expect(screen.getByRole("button", { name: "Sandbox" }).textContent).toContain("Read only");
  });
});

describe("labels", () => {
  const models = [{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }, { provider: "claude", id: "sonnet", name: "Claude Sonnet" }] as never[];
  it("names models like the picker, falling back to the raw id", () => {
    expect(modelName("anthropic/claude-haiku-4-5", models)).toBe("Claude Haiku 4.5");
    expect(modelName("claude-code/claude-haiku-4-5", models)).toBe("Claude Haiku 4.5");
    expect(modelName("sonnet", models)).toBe("Claude Sonnet");
    expect(modelName("x/unknown", models)).toBe("unknown");
  });
  it("says what inherit means", () => {
    const label = (id: string) => ({ codex: "Codex" })[id] ?? id;
    expect(harnessModelLine({ harness: "inherit", model: "inherit" }, label, [])).toBe("Same agent and model as the parent chat");
    expect(harnessModelLine({ harness: "codex", model: "inherit" }, label, [])).toBe("Codex · sub-agent model");
  });
  it("knows Glade's own tools", () => {
    expect(["mcp__glade__spawn_agent", "report_done", "message_agent", "Read", "mcp__github__x"].filter(isGladeTool)).toEqual(["mcp__glade__spawn_agent", "report_done", "message_agent"]);
  });
});

describe("discovered agents", () => {
  it("open read only; Customize saves a Glade file that extends the source with only the changes", async () => {
    renderAt(`/settings/subagents/edit/${encodeURIComponent("claude:reviewer")}`);
    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    expect(name.value).toBe("reviewer");
    expect(name.closest("fieldset")!.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    // Only the name is set; the source's values show greyed.
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).placeholder).toBe("Reviews diffs.");
    expect(screen.getByText("Review carefully.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("From Claude Code: haiku");
    fireEvent.input(screen.getByLabelText("Add to Nicknames"), { target: { value: "Rex," } });
    fireEvent.click(screen.getByRole("button", { name: "Save Customization" }));
    await waitFor(() => expect(defs.saveAgentDef).toHaveBeenCalled());
    expect(defs.saveAgentDef.mock.calls[0]![0]).toEqual({
      scope: "personal",
      projectId: null,
      fields: { ...emptyAgentDefFields("inherit"), name: "reviewer", extends: "claude:reviewer", nicknames: ["Rex"] },
    });
    expect(customizeDraft(REVIEWER)).toMatchObject({ harness: "inherit", model: "inherit", thinking: "inherit", tools: null, prompt: "" });
  });

  it("editing a Glade file that extends one greys the source's own values (`base`), not this file's overrides", async () => {
    const own = fieldsOf({ name: "rex", harness: "inherit", extends: "claude:reviewer", description: "Mine.", model: "anthropic/opus" });
    const rex = def({ fields: own, effective: { ...REVIEWER_FIELDS, name: "rex", description: "Mine.", model: "anthropic/opus" }, base: REVIEWER_FIELDS });
    defs.listAgentDefs.mockResolvedValue([rex]);
    renderAt(`/settings/subagents/edit/${encodeURIComponent("personal:rex")}`);
    const description = (await screen.findByLabelText("Description")) as HTMLTextAreaElement;
    expect(description.value).toBe("Mine.");
    // The source's own description, not the effective one (which is this file's "Mine.").
    expect(description.placeholder).toBe("Reviews diffs.");
  });

  it("a project's own discovered agent is customized for that project", async () => {
    const local = def({ source: "claude", path: "/p1/.claude/agents/local.md", fields: fieldsOf({ name: "local", prompt: "x" }) });
    defs.listAgentDefs.mockResolvedValue([local]);
    renderAt(`/settings/subagents/edit/${encodeURIComponent("claude:local")}?project=p1`);
    fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Customization" }));
    await waitFor(() => expect(defs.saveAgentDef).toHaveBeenCalled());
    expect(defs.saveAgentDef.mock.calls[0]![0]).toMatchObject({ scope: "project", projectId: "p1", fields: { name: "local", extends: "claude:local" } });
  });

  it("Glade agents can be renamed and deleted", async () => {
    defs.deleteAgentDef.mockResolvedValue(undefined);
    renderAt(`/settings/subagents/edit/${encodeURIComponent("personal:scout")}`);
    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    fireEvent.input(name, { target: { value: "finder" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(defs.saveAgentDef).toHaveBeenCalled());
    expect(defs.saveAgentDef.mock.calls[0]![0]).toMatchObject({ scope: "personal", previousName: "scout", fields: { name: "finder" } });

    renderAt(`/settings/subagents/edit/${encodeURIComponent("personal:scout")}`);
    fireEvent.click((await screen.findAllByRole("button", { name: "Delete" }))[0]!);
    const alert = await screen.findByRole("alertdialog");
    fireEvent.click(within(alert).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(defs.deleteAgentDef).toHaveBeenCalledWith("personal", "scout", null, expect.any(Function)));
  });
});
