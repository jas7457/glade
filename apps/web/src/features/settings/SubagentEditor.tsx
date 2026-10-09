/**
 * One agent's page under Settings → Sub-agents (I-218): `/settings/subagents/new/<harness>`
 * creates a Glade agent on the harness picked first (New Agent ▾), `/settings/subagents/edit/<id>`
 * edits a Glade agent (rename, delete) or shows a discovered one read only with **Customize**
 * (a Glade file with the same name that `extends` it and sets only what you change).
 *
 * Shared settings on top (name, nicknames, description with "Write description for me", prompt,
 * agent, model, thinking, colour, icon, where it's saved), then the harness's own settings with a
 * Read-only preset: pi's tools; Claude Code's tools, denied tools and permission mode; Codex's
 * sandbox. Tool lists are the harness's live list from its last session (`GET
 * /api/agent-defs/tools`); tools named in the file but missing there stay checked, marked "not
 * available right now". With `extends`, empty fields show the source's values greyed, and
 * `inherit` reads "From <source>".
 */
import { useEffect, useState } from "preact/hooks";
import { Navigate, useNavigate, useParams } from "react-router";
import { Ban, Lock, Sparkles, Trash2 } from "lucide-preact";
import {
  AGENT_COLORS,
  AGENT_ICONS,
  CODEX_SANDBOX_MODES,
  INHERIT,
  MAX_AGENT_DEF_DESCRIPTION,
  MAX_AGENT_DEF_PROMPT,
  MAX_AGENT_NICKNAMES,
  THINKING_LEVELS,
  emptyAgentDefFields,
  modelKey,
  normalizeAgentDefName,
  parseModelKey,
  sameModel,
  type AgentDef,
  type AgentDefFields,
  type AgentDefScope,
  type AgentDefToolsResponse,
  type CodexSandboxMode,
  type ThinkingLevel,
} from "@glade/protocol";
import { routes } from "@glade/app-core/app/routes";
import { describeAgentDef, getAgentDefTools } from "@glade/app-core/lib/api-agent-defs";
import { request } from "@glade/app-core/lib/api";
import { requestFor } from "@glade/app-core/state/env-api";
import { harnessName } from "@glade/app-core/state/harnesses";
import { hostAgentModels, hostEnvId, hostHarnesses, hostModelsFor, hostProjects, hostReadOnly, hostVisibleModelsFor } from "@glade/app-core/state/host-settings";
import { agentDefsOf, deleteAgentDef, loadAgentDefs, saveAgentDef } from "@glade/app-core/state/agent-defs";
import { cn } from "@glade/app-core/lib/cn";
import {
  AgentIconGlyph,
  AGENT_ICON_COMPONENTS,
  Button,
  Checkbox,
  ChoiceGrid,
  FormGroup,
  FormRow,
  Select,
  SegmentedControl,
  Spinner,
  TextArea,
  TextField,
  TokenField,
  confirm,
  type SelectOption,
} from "@glade/app-core/ui";
import { SettingsView } from "./SettingsView";
import { usePickedProject } from "./SubagentSettings";
import { THINKING_LABELS, agentThinkingLevels, groupModels } from "./ModelSettings";
import {
  CLAUDE_PERMISSION_MODES,
  CODEX_SANDBOX_LABELS,
  SOURCE_LABELS,
  customizeDraft,
  effectiveHarness,
  extendsSourceLabel,
  modelName,
  isGladeTool,
  readOnlyPreset,
} from "./subagent-defs";

/** Route element for `/settings/subagents/:mode/:key` (`new/<harness>` or `edit/<agent id>`). */
export function SettingsSubagentRoute() {
  const { mode, key = "" } = useParams();
  const projectId = usePickedProject();
  const envId = hostEnvId();
  const back = routes.settingsSubagents(projectId);
  const { agents } = agentDefsOf(projectId);
  useEffect(() => {
    if (mode === "edit" && agents === null) void loadAgentDefs(projectId);
  }, [mode, projectId, envId]);
  if (mode === "new") {
    return (
      <SettingsView
        section="subagents"
        agent={{ id: "", label: "New Agent", back, page: <SubagentEditor key={`new:${key}`} target={{ kind: "new", harness: key }} projectId={projectId} /> }}
      />
    );
  }
  if (mode !== "edit") return <Navigate to={back} replace />;
  const def = agents?.find((a) => a.id === key);
  if (agents && !def) return <Navigate to={back} replace />;
  return (
    <SettingsView
      section="subagents"
      agent={{
        id: "",
        label: def?.fields.name ?? "Agent",
        back,
        page: def ? (
          <SubagentEditor key={def.id} target={{ kind: "def", def }} projectId={projectId} />
        ) : (
          <div class="flex items-center gap-2 text-fg-muted">
            <Spinner size={12} /> Loading…
          </div>
        ),
      }}
    />
  );
}

export type EditorTarget = { kind: "new"; harness: string } | { kind: "def"; def: AgentDef };

/** The harness's tools as last seen (`null` while loading). */
function useHarnessTools(harness: string, projectId: string | null): AgentDefToolsResponse | null {
  const [tools, setTools] = useState<AgentDefToolsResponse | null>(null);
  useEffect(() => {
    if (harness === INHERIT || harness === "codex") return setTools({ harness, tools: [], mcpServers: [], seenAt: null });
    let live = true;
    setTools(null);
    getAgentDefTools(harness, projectId, requestFor(hostEnvId()) ?? request)
      .then((t) => live && setTools(t))
      .catch(() => live && setTools({ harness, tools: [], mcpServers: [], seenAt: null }));
    return () => {
      live = false;
    };
  }, [harness, projectId]);
  return tools;
}

const field = "flex flex-col gap-1.5 px-3 py-2.5";
const hint = "text-[0.92rem] leading-snug text-fg-muted";

export function SubagentEditor({ target, projectId }: { target: EditorTarget; projectId: string | null }) {
  const navigate = useNavigate();
  const def = target.kind === "def" ? target.def : null;
  const [customizing, setCustomizing] = useState(false);
  const [fields, setFields] = useState<AgentDefFields>(() =>
    def ? { ...(def.editable ? def.fields : def.effective) } : emptyAgentDefFields(target.kind === "new" ? target.harness : INHERIT),
  );
  const project = hostProjects.value.find((p) => p.id === projectId) ?? null;
  const canProject = !!project && project.path !== null;
  const [scope, setScope] = useState<AgentDefScope>(def?.editable ? (def.source as AgentDefScope) : "personal");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [describeError, setDescribeError] = useState<string | null>(null);

  const viewOnly = !!def && !def.editable && !customizing;
  const deviceReadOnly = hostReadOnly.value;
  // With `extends`: the source's values alone (`base`, without this file's overrides), shown greyed
  // where this file sets nothing. Older servers send no `base`: their effective values.
  const base = customizing ? def!.effective : def?.editable && def.fields.extends ? (def.base !== undefined ? def.base : def.effective) : null;
  const from = extendsSourceLabel(fields.extends);
  const harness = effectiveHarness(fields, base);
  const tools = useHarnessTools(harness, projectId);
  const set = (patch: Partial<AgentDefFields>) => setFields((f) => ({ ...f, ...patch }));
  const name = normalizeAgentDefName(fields.name);
  const valid = name !== "" && (fields.prompt.trim() !== "" || !!fields.extends);
  const harnessLabel = (id: string) => harnessName(id, hostEnvId());

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveAgentDef(
        {
          scope,
          projectId: scope === "project" ? projectId : null,
          fields: { ...fields, name },
          ...(def?.editable ? { previousName: def.fields.name } : {}),
        },
        projectId,
      );
      navigate(routes.settingsSubagents(projectId));
    } catch (err) {
      setError((err as Error).message || "Could not save the agent");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!def?.editable) return;
    const ok = await confirm({
      title: "Delete agent?",
      subject: def.fields.name,
      message: `will be deleted (${def.path}). This can't be undone.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteAgentDef(def.source as AgentDefScope, def.fields.name, def.source === "project" ? projectId : null, projectId);
      navigate(routes.settingsSubagents(projectId));
    } catch (err) {
      setError((err as Error).message || "Could not delete the agent");
    }
  };

  const describe = async () => {
    setDescribing(true);
    setDescribeError(null);
    try {
      const description = await describeAgentDef({ name: name || fields.name, harness, prompt: fields.prompt || base?.prompt || "" }, requestFor(hostEnvId()) ?? request);
      set({ description });
    } catch (err) {
      setDescribeError((err as Error).message || "Could not write a description");
    } finally {
      setDescribing(false);
    }
  };

  const preset = readOnlyPreset(harness, tools?.tools ?? []);

  return (
    <>
      {def && !def.editable && (
        <FormGroup>
          <FormRow
            label={
              <span class="inline-flex items-center gap-1.5">
                {!customizing && <Lock size={12} class="text-fg-muted" />}
                {customizing ? `Customizing ${SOURCE_LABELS[def.source]}'s ${def.fields.name}` : `From ${SOURCE_LABELS[def.source]}`}
              </span>
            }
            description={
              customizing ? (
                <>
                  Glade saves a file of its own that extends <span class="font-mono">{def.path}</span> and changes only what you set here;
                  that file stays as it is and its updates still apply.
                </>
              ) : (
                <>
                  <span class="font-mono [overflow-wrap:anywhere]">{def.path}</span>. Glade uses it as it is and never changes it.
                </>
              )
            }
          >
            {!customizing && !deviceReadOnly && (
              <Button
                size="sm"
                onClick={() => {
                  setFields(customizeDraft(def));
                  // A project's own agent (e.g. its .claude/agents) is customized for that project.
                  if (canProject && project?.path && def.path.startsWith(`${project.path}/`)) setScope("project");
                  setCustomizing(true);
                }}
              >
                Customize
              </Button>
            )}
          </FormRow>
        </FormGroup>
      )}
      {def && (def.problems.length > 0 || def.shadowedBy) && (
        <FormGroup>
          {def.problems.map((p) => (
            <FormRow key={p} label={<span class={def.available ? "text-warning" : "text-danger"}>{p}</span>} />
          ))}
          {def.shadowedBy && <FormRow label={<span class="text-fg-muted">Overridden by {def.shadowedBy}: that one is used.</span>} />}
        </FormGroup>
      )}

      <fieldset disabled={viewOnly} class={cn("min-w-0", viewOnly && "[&_textarea]:opacity-80")}>
        <FormGroup title="Agent">
          <div class={field}>
            <label for="agent-name" class="font-medium">
              Name
            </label>
            <TextField id="agent-name" class="w-[260px]" value={fields.name} placeholder="scout" onInput={(e) => set({ name: e.currentTarget.value })} />
            <p class={hint}>
              {name && name !== fields.name ? (
                <>
                  Saved as <span class="font-mono text-fg">{name}</span>.{" "}
                </>
              ) : null}
              What a chat asks for ("have {name || "scout"} look"), shown greyed next to its nickname.
            </p>
          </div>
          <div class={field}>
            <span class="font-medium">Nicknames</span>
            <TokenField
              aria-label="Nicknames"
              values={fields.nicknames}
              inherited={base?.nicknames}
              max={MAX_AGENT_NICKNAMES}
              placeholder="Brandon, Bea"
              onChange={(nicknames) => set({ nicknames })}
            />
            <p class={hint}>Shown on its cards and tabs; the first free one is used. None: a random name each time.</p>
          </div>
          <div class={field}>
            <div class="flex items-center justify-between gap-2">
              <label for="agent-description" class="font-medium">
                Description
              </label>
              {!viewOnly && (
                <Button size="sm" variant="ghost" disabled={describing || !(fields.prompt.trim() || base?.prompt)} onClick={() => void describe()}>
                  {describing ? <Spinner size={12} /> : <Sparkles size={12} />}
                  Write description for me
                </Button>
              )}
            </div>
            <TextArea
              id="agent-description"
              rows={3}
              value={fields.description}
              maxLength={MAX_AGENT_DEF_DESCRIPTION}
              placeholder={base?.description || "Use when you need to find where something is defined or used before changing code. Not for making changes."}
              onInput={(e) => set({ description: e.currentTarget.value })}
            />
            {describeError && <p class="text-[0.92rem] text-danger">{describeError}</p>}
            <p class={hint}>Only the chat reads this, to decide when to use the agent. Say when to use it and when not.</p>
          </div>
          <div class={field}>
            <label for="agent-prompt" class="font-medium">
              {fields.extends ? `Prompt (added to ${from}'s)` : "Prompt"}
            </label>
            {base?.prompt && (
              <div class="max-h-32 overflow-y-auto rounded-[5px] border-[0.5px] border-dashed border-separator px-2 py-1.5 font-mono text-[0.88rem] whitespace-pre-wrap text-fg-subtle select-text">
                {base.prompt}
              </div>
            )}
            <TextArea
              id="agent-prompt"
              rows={10}
              class="font-mono text-[0.92rem]"
              value={fields.prompt}
              maxLength={MAX_AGENT_DEF_PROMPT}
              placeholder={fields.extends ? "Anything to add (optional)" : "Trace the real code path, cite file:line, never propose fixes unless asked."}
              onInput={(e) => set({ prompt: e.currentTarget.value })}
            />
            <p class={hint}>Only the agent reads this: how to do its job. The chat adds the task each time it starts it.</p>
          </div>
          <HarnessRows fields={fields} base={base} from={from} set={set} harnessLabel={harnessLabel} />
          <div class={field}>
            <span class="font-medium">Colour</span>
            <ChoiceGrid
              aria-label="Colour"
              value={fields.color ?? ""}
              onChange={(v) => set({ color: (v || null) as AgentDefFields["color"] })}
              options={[
                {
                  value: "",
                  label: base?.color ? `From ${from} (${base.color})` : "Assigned automatically",
                  content: base?.color ? <span data-agent-color={base.color} class="size-3.5 rounded-full border border-dashed border-agent" /> : <Ban />,
                },
                ...AGENT_COLORS.map((c) => ({ value: c, label: c[0]!.toUpperCase() + c.slice(1), attrs: { "data-agent-color": c }, content: <span class="size-3.5 rounded-full bg-agent" /> })),
              ]}
            />
          </div>
          <div class={field}>
            <span class="font-medium">Icon</span>
            <ChoiceGrid
              aria-label="Icon"
              value={fields.icon ?? ""}
              onChange={(v) => set({ icon: (v || null) as AgentDefFields["icon"] })}
              options={[
                { value: "", label: base?.icon ? `From ${from} (${base.icon})` : "None", content: base?.icon ? <AgentIconGlyph icon={base.icon} class="opacity-50" /> : <Ban /> },
                ...AGENT_ICONS.map((i) => {
                  const Icon = AGENT_ICON_COMPONENTS[i];
                  return { value: i, label: i[0]!.toUpperCase() + i.slice(1), content: <Icon /> };
                }),
              ]}
            />
          </div>
          {(!def || customizing) && (
            <FormRow label="Saved for" description={scope === "project" ? `In ${project?.name ?? "the project"}'s .agents/agents folder, shared with everyone who uses the repo.` : "In Glade's data folder, for all your chats."}>
              <SegmentedControl
                aria-label="Saved for"
                value={scope}
                onChange={setScope}
                options={[
                  { value: "personal", label: "Me" },
                  { value: "project", label: project ? project.name : "This project", disabled: !canProject },
                ]}
              />
            </FormRow>
          )}
        </FormGroup>

        {harness !== INHERIT && (
          <FormGroup
            title={`${harnessLabel(harness)} settings`}
            actions={
              preset &&
              !viewOnly && (
                <Button size="sm" onClick={() => set(preset)}>
                  Read only
                </Button>
              )
            }
            footer={
              harness === "claude"
                ? "Read only allows reading, searching and web lookups and denies the editing tools. Shell commands still ask for permission."
                : harness === "pi"
                  ? "Read only allows read, grep, find and ls."
                  : harness === "codex"
                    ? "Read only runs it in Codex's read-only sandbox."
                    : undefined
            }
          >
            {(harness === "pi" || harness === "claude") && (
              <ToolList
                label="Tools"
                harness={harness}
                tools={tools}
                value={fields.tools}
                inherited={base?.tools ?? null}
                from={from}
                onChange={(t) => set({ tools: t })}
              />
            )}
            {harness === "claude" && (
              <>
                <ToolList
                  label="Denied tools"
                  deny
                  harness={harness}
                  tools={tools}
                  value={fields.disallowedTools}
                  inherited={base?.disallowedTools ?? null}
                  from={from}
                  onChange={(t) => set({ disallowedTools: t })}
                />
                <FormRow label="Permission mode">
                  <Select
                    aria-label="Permission mode"
                    class="w-[240px]"
                    value={fields.permissionMode ?? ""}
                    onChange={(v) => set({ permissionMode: v || null })}
                    options={[
                      { value: "", label: base?.permissionMode ? `From ${from}: ${permissionLabel(base.permissionMode)}` : "The chat's mode" },
                      ...CLAUDE_PERMISSION_MODES,
                      ...(fields.permissionMode && !CLAUDE_PERMISSION_MODES.some((m) => m.value === fields.permissionMode)
                        ? [{ value: fields.permissionMode, label: fields.permissionMode }]
                        : []),
                    ]}
                  />
                </FormRow>
              </>
            )}
            {harness === "codex" && (
              <FormRow label="Sandbox">
                <Select
                  aria-label="Sandbox"
                  class="w-[240px]"
                  value={fields.sandbox ?? ""}
                  onChange={(v) => set({ sandbox: (v || null) as CodexSandboxMode | null })}
                  options={[
                    { value: "", label: base?.sandbox ? `From ${from}: ${CODEX_SANDBOX_LABELS[base.sandbox]}` : "Codex's default" },
                    ...CODEX_SANDBOX_MODES.map((m) => ({ value: m, label: CODEX_SANDBOX_LABELS[m] ?? m })),
                  ]}
                />
              </FormRow>
            )}
          </FormGroup>
        )}
      </fieldset>

      {error && (
        <p role="alert" class="mb-4 text-danger">
          {error}
        </p>
      )}
      {!viewOnly && (
        <div class="flex items-center gap-2">
          {def?.editable && (
            <Button variant="ghost" onClick={() => void remove()}>
              <Trash2 size={12} />
              Delete
            </Button>
          )}
          <span class="flex-1" />
          <Button onClick={() => navigate(routes.settingsSubagents(projectId))}>Cancel</Button>
          <Button variant="primary" disabled={!valid || busy} onClick={() => void save()}>
            {def?.editable ? "Save" : customizing ? "Save Customization" : "Create Agent"}
          </Button>
        </div>
      )}
    </>
  );
}

function permissionLabel(mode: string): string {
  return CLAUDE_PERMISSION_MODES.find((m) => m.value === mode)?.label ?? mode;
}

/** Agent, model and thinking: the per-harness pickers, `inherit` first. */
function HarnessRows({
  fields,
  base,
  from,
  set,
  harnessLabel,
}: {
  fields: AgentDefFields;
  base: AgentDefFields | null;
  from: string | null;
  set: (patch: Partial<AgentDefFields>) => void;
  harnessLabel: (id: string) => string;
}) {
  const offered = hostHarnesses.value ?? [];
  const harness = effectiveHarness(fields, base);
  const all = harness === INHERIT ? [] : hostModelsFor(harness);
  const visible = harness === INHERIT ? [] : hostVisibleModelsFor(harness);
  const harnessOptions: SelectOption<string>[] = [
    { value: INHERIT, label: base ? (base.harness === INHERIT || harnessLabel(base.harness) === from ? `From ${from}` : `From ${from}: ${harnessLabel(base.harness)}`) : "Same as the parent chat" },
    ...offered.map((h) => ({ value: h.id, label: h.label })),
    ...(fields.harness !== INHERIT && !offered.some((h) => h.id === fields.harness) ? [{ value: fields.harness, label: `${harnessLabel(fields.harness)} (turned off)` }] : []),
  ];
  const baseModel = base && base.model !== INHERIT ? modelName(base.model, all) : null;
  // `inherit` on a specific agent: that agent's sub-agent model / thinking settings (Settings → Agents).
  const sub = harness === INHERIT ? null : hostAgentModels(harness);
  const subModelLabel = sub?.subagentModel ? `Sub-agent model (${modelName(modelKey(sub.subagentModel), all)})` : "Sub-agent model setting";
  const subThinkingLabel = sub?.subagentThinkingLevel ? `Sub-agent thinking (${THINKING_LABELS[sub.subagentThinkingLevel]})` : "Sub-agent thinking setting";
  const ref = fields.model !== INHERIT ? parseModelKey(fields.model) : null;
  const modelOptions: SelectOption<string>[] = [
    { value: INHERIT, label: base ? (baseModel ? `From ${from}: ${baseModel}` : `From ${from}`) : harness === INHERIT ? "Same as the parent chat" : subModelLabel },
    ...groupModels(visible).flatMap(([group, ms]) => ms.map((m) => ({ value: modelKey(m), label: m.name, group }))),
    ...(fields.model !== INHERIT && !visible.some((m) => modelKey(m) === fields.model) ? [{ value: fields.model, label: modelName(fields.model, all) }] : []),
  ];
  const chosen = ref ? all.find((m) => sameModel(m, ref)) : undefined;
  const levels: ThinkingLevel[] = chosen?.thinkingLevels?.length ? chosen.thinkingLevels : harness === INHERIT ? [...THINKING_LEVELS] : agentThinkingLevels(all);
  const thinkingOptions: SelectOption<string>[] = [
    { value: INHERIT, label: base ? (base.thinking === INHERIT ? `From ${from}` : `From ${from}: ${THINKING_LABELS[base.thinking]}`) : harness === INHERIT ? "Same as the parent chat" : subThinkingLabel },
    ...levels.map((l) => ({ value: l, label: THINKING_LABELS[l] })),
    ...(fields.thinking !== INHERIT && !levels.includes(fields.thinking) ? [{ value: fields.thinking, label: THINKING_LABELS[fields.thinking] }] : []),
  ];
  return (
    <>
      <FormRow label="Runs on" description={fields.harness === INHERIT && !base ? "The agent of the chat that starts it." : undefined}>
        <Select aria-label="Runs on" class="w-[240px]" value={fields.harness} options={harnessOptions} onChange={(h) => set({ harness: h, model: INHERIT, thinking: INHERIT })} />
      </FormRow>
      <FormRow label="Model" description={harness === INHERIT ? "Pick an agent above to choose a model." : undefined}>
        <Select aria-label="Model" class="w-[240px]" disabled={harness === INHERIT} value={fields.model} options={modelOptions} onChange={(model) => set({ model })} />
      </FormRow>
      <FormRow label="Thinking">
        <Select aria-label="Thinking" class="w-[240px]" value={fields.thinking} options={thinkingOptions} onChange={(t) => set({ thinking: t as AgentDefFields["thinking"] })} />
      </FormRow>
    </>
  );
}

/**
 * A tool checklist from the harness's live list (allow list, or `deny`: tools denied). `null` =
 * not set (the harness's defaults, or the source's with `extends`); tools in the value that the
 * live list doesn't have stay checked, marked "not available right now".
 */
function ToolList({
  label,
  deny = false,
  harness,
  tools,
  value,
  inherited,
  from,
  onChange,
}: {
  label: string;
  deny?: boolean;
  harness: string;
  tools: AgentDefToolsResponse | null;
  value: string[] | null;
  inherited: string[] | null;
  from: string | null;
  onChange: (value: string[] | null) => void;
}) {
  const live = (tools?.tools ?? []).filter((t) => !isGladeTool(t));
  const missing = (value ?? []).filter((t) => !live.includes(t));
  const notSet = deny ? "None" : "All tools";
  const mode = value === null ? "unset" : "list";
  return (
    <div class={field} role="group" aria-label={label}>
      <div class="flex items-center justify-between gap-2">
        <span class="font-medium">{label}</span>
        <SegmentedControl
          size="sm"
          aria-label={`${label} mode`}
          value={mode}
          onChange={(m) => onChange(m === "unset" ? null : (inherited ?? []).slice())}
          options={[
            { value: "unset", label: inherited ? `From ${from}` : notSet },
            { value: "list", label: deny ? "Deny these" : "Only these" },
          ]}
        />
      </div>
      {value === null ? (
        <p class={hint}>{inherited ? inherited.join(", ") || notSet : deny ? "No tools denied." : `Every tool ${harnessName(harness, hostEnvId())} has.`}</p>
      ) : (
        <>
          {tools === null ? (
            <p class={cn(hint, "flex items-center gap-2")}>
              <Spinner size={12} /> Loading tools…
            </p>
          ) : tools.seenAt === null ? (
            <p class={hint}>Start a chat with {harnessName(harness, hostEnvId())} to load its tools.</p>
          ) : null}
          <div class="grid grid-cols-2 gap-x-4 gap-y-1">
            {[...live, ...missing].map((t) => {
              const checked = value.includes(t);
              return (
                <label key={t} class="flex min-w-0 items-center gap-1.5 select-none">
                  <Checkbox
                    aria-label={t}
                    checked={checked}
                    onCheckedChange={(on) => onChange(on ? [...value, t] : value.filter((x) => x !== t))}
                  />
                  <span class="min-w-0 truncate font-mono text-[0.9rem]" title={t}>
                    {t}
                  </span>
                  {/* Only once the live list is known: before that, nothing says it's missing. */}
                  {missing.includes(t) && tools?.seenAt != null && <span class="shrink-0 text-[0.85rem] text-fg-subtle">not available right now</span>}
                </label>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
