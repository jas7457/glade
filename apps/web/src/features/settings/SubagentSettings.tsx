/**
 * Settings → Sub-agents (`/settings/subagents[?project=<id>]`, I-218): the agent definitions an
 * orchestrator can pick when it starts a sub-agent, as seen from all chats or one project
 * (project agents and switches apply there). Glade's own agents first, then the ones discovered
 * in Claude Code, Codex and pi (read only). One agent per name (I-220): a customized agent stays
 * on its source's row (values are the customized ones) with a "Customized" badge. Each row: icon
 * in its colour, name and nicknames, harness · model, source badge (file path on hover),
 * problems, and an on/off
 * switch (everywhere, or for the picked project: `Settings.agentDefs`; a project's own setting
 * says so and has a reset back to the all-chats switch). A row opens the agent's
 * page (`SubagentEditor`); New Agent asks for the harness first.
 *
 * A host section (I-155): another device's agents are view only (SettingsView disables the panel).
 */
import { useEffect } from "preact/hooks";
import { useNavigate, useSearchParams } from "react-router";
import { ChevronDown, Plus, RotateCcw } from "lucide-preact";
import { INHERIT, type AgentDefSource } from "@glade/protocol";
import { routes } from "@glade/app-core/app/routes";
import { AgentIconGlyph, Badge, Button, FormGroup, FormLinkRow, FormRow, IconButton, Menu, MenuItem, MenuSeparator, Select, Spinner, Switch } from "@glade/app-core/ui";
import { hostEnvId, hostModelsFor, hostProjects, hostSettings, updateHostSettings } from "@glade/app-core/state/host-settings";
import { harnessName } from "@glade/app-core/state/harnesses";
import { agentDefOn, agentDefOverride, agentDefsOf, clearAgentDefOverride, loadAgentDefs, setAgentDefOn } from "@glade/app-core/state/agent-defs";
import { HARNESS_CHOICES, SOURCE_LABELS, agentRows, harnessModelLine, rowAgent, type AgentRow } from "./subagent-defs";

const ALL = "__all__";

/** The project picked at the top (`?project=`), if it still exists. */
export function usePickedProject(): string | null {
  const [params] = useSearchParams();
  const id = params.get("project");
  return id && hostProjects.value.some((p) => p.id === id) ? id : null;
}

const GROUPS: Array<{ title: string; sources: AgentDefSource[] }> = [
  { title: "Glade", sources: ["project", "personal"] },
  { title: "Claude Code", sources: ["claude"] },
  { title: "Codex", sources: ["codex"] },
  { title: "pi", sources: ["pi"] },
];

/** "New Agent ▾": the harness comes first (I-218). */
export function NewAgentMenu({ projectId }: { projectId: string | null }) {
  const navigate = useNavigate();
  return (
    <Menu
      align="end"
      trigger={
        <Button size="sm">
          <Plus size={12} />
          New Agent
          <ChevronDown size={11} class="text-fg-muted" />
        </Button>
      }
    >
      {HARNESS_CHOICES.map((h) =>
        h === INHERIT ? (
          [
            <MenuSeparator key="sep" />,
            <MenuItem key={h} onSelect={() => navigate(routes.settingsSubagentNew(h, projectId))}>
              Same Agent as the Parent Chat
            </MenuItem>,
          ]
        ) : (
          <MenuItem key={h} onSelect={() => navigate(routes.settingsSubagentNew(h, projectId))}>
            {harnessName(h, hostEnvId())}
          </MenuItem>
        ),
      )}
    </Menu>
  );
}

/**
 * The two per-device switches at the top (I-221): sub-agents on another agent, and with their own
 * model/thinking. Both off by default; off, the server keeps every sub-agent on its chat's agent
 * and model. Another device's page is view only (the panel's fieldset).
 */
export function SubagentSwitches() {
  const a = hostSettings.value.agent;
  return (
    <FormGroup class="mb-5">
      <FormRow label="Use other agents for sub-agents" description="Let a chat hand work to a sub-agent on another agent, e.g. a pi chat to Claude Code.">
        <Switch
          aria-label="Use other agents for sub-agents"
          checked={a.subagentOtherHarnesses === true}
          onCheckedChange={(subagentOtherHarnesses) => void updateHostSettings({ agent: { subagentOtherHarnesses } })}
        />
      </FormRow>
      <FormRow label="Use other models for sub-agents" description="Let sub-agents use their own model and thinking instead of the chat's.">
        <Switch
          aria-label="Use other models for sub-agents"
          checked={a.subagentOtherModels === true}
          onCheckedChange={(subagentOtherModels) => void updateHostSettings({ agent: { subagentOtherModels } })}
        />
      </FormRow>
    </FormGroup>
  );
}

export function SubagentSettings() {
  const navigate = useNavigate();
  const projectId = usePickedProject();
  const envId = hostEnvId();
  const { agents, error } = agentDefsOf(projectId);
  useEffect(() => void loadAgentDefs(projectId), [projectId, envId]);
  const projects = hostProjects.value;
  const projectName = projects.find((p) => p.id === projectId)?.name ?? null;

  return (
    <>
      <p class="mb-4 text-fg-muted">
        Agents a chat can hand work to: each has its own agent, model, prompt and permissions. The chat picks one by its description, or
        when you name it. Agents from Claude Code, Codex and pi are listed as they are; customize one to change it in Glade.
      </p>
      <SubagentSwitches />
      <div class="mb-5 flex items-center gap-2">
        <span class="text-fg-muted select-none">Show for</span>
        <Select
          aria-label="Show agents for"
          value={projectId ?? ALL}
          onChange={(v) => navigate(routes.settingsSubagents(v === ALL ? null : v), { replace: true })}
          options={[{ value: ALL, label: "All chats" }, ...projects.map((p) => ({ value: p.id, label: p.name, group: "Project" }))]}
        />
        <span class="flex-1" />
        <NewAgentMenu projectId={projectId} />
      </div>
      {error && (
        <FormGroup>
          <FormRow label={<span class="text-danger">{error}</span>} />
        </FormGroup>
      )}
      {agents === null && !error && (
        <div class="flex items-center gap-2 text-fg-muted">
          <Spinner size={12} /> Loading agents…
        </div>
      )}
      {agents &&
        GROUPS.map((group) => {
          const list = agentRows(agents).filter((r) => group.sources.includes(r.def.source));
          if (group.title !== "Glade" && list.length === 0) return null;
          return (
            <FormGroup
              key={group.title}
              title={group.title}
              footer={
                group.title === "Glade"
                  ? projectId
                    ? `Switches here apply to ${projectName ?? "this project"}'s chats only; ↺ goes back to the setting for all chats.`
                    : "Switches here apply to every chat; a project can override them."
                  : undefined
              }
            >
              {list.length === 0 && <FormRow label={<span class="text-fg-muted">No agents yet. Use New Agent to create one.</span>} />}
              {list.map((row) => (
                <AgentDefRow key={row.def.id} row={row} projectId={projectId} onOpen={() => navigate(routes.settingsSubagent(rowAgent(row).id, projectId))} />
              ))}
            </FormGroup>
          );
        })}
    </>
  );
}

function AgentDefRow({ row, projectId, onOpen }: { row: AgentRow; projectId: string | null; onOpen: () => void }) {
  const source = row.def;
  // A customized agent shows the customization's values; the badge names the source.
  const def = rowAgent(row);
  const f = def.effective;
  const on = agentDefOn(f.name, projectId);
  const override = projectId ? agentDefOverride(f.name, projectId) : null;
  const globalOn = agentDefOn(f.name, null);
  const harness = f.harness === INHERIT ? null : f.harness;
  const line = harnessModelLine(f, (id) => harnessName(id, hostEnvId()), harness ? hostModelsFor(harness) : []);
  return (
    <FormLinkRow
      aria-label={f.name}
      label={
        <span class="flex min-w-0 items-center gap-1.5" data-agent-color={f.color ?? undefined}>
          <span class={f.color ? "flex text-agent" : "flex text-fg-muted"}>
            <AgentIconGlyph icon={f.icon} fallback size={13} />
          </span>
          <span class="shrink-0 font-medium">{f.name}</span>
          {f.nicknames.length > 0 && <span class="min-w-0 truncate text-fg-muted">{f.nicknames.join(", ")}</span>}
          <span class="ml-auto flex shrink-0 items-center gap-1">
            {row.custom && <Badge title={`${def.path} extends ${source.path}`}>Customized</Badge>}
            <Badge title={source.path}>{SOURCE_LABELS[source.source]}</Badge>
          </span>
        </span>
      }
      description={
        <>
          <span class="block">{line}</span>
          {f.description && <span class="line-clamp-2 block [overflow-wrap:anywhere]">{f.description}</span>}
          {!def.available && <span class="block text-danger">Can't be used: {def.problems.join("; ") || "unavailable"}</span>}
          {def.available && def.problems.length > 0 && <span class="block text-warning">{def.problems.join("; ")}</span>}
          {override !== null && <span class="block text-fg-subtle">Set for this project (all chats: {globalOn ? "on" : "off"})</span>}
        </>
      }
      accessory={
        <>
          {override !== null && projectId && (
            <IconButton size="sm" label={`Use the setting for all chats (${globalOn ? "on" : "off"})`} onClick={() => void clearAgentDefOverride(f.name, projectId)}>
              <RotateCcw size={12} />
            </IconButton>
          )}
          <Switch aria-label={`Use ${f.name}`} checked={on} onCheckedChange={(v) => void setAgentDefOn(f.name, projectId, v)} />
        </>
      }
      onSelect={onOpen}
    />
  );
}
