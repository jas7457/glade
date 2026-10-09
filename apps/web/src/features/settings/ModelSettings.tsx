/**
 * Model settings (I-198): per agent on its page under Settings → Agents (`AgentModelGroups`:
 * "Defaults" and "Models", only that agent's models), and the one Glade-wide quick-tasks model
 * (`QuickTasksRow`, on the Agents page), picked as agent + model. The global Models page was
 * folded into Agents. Helpers for grouping models live here too (families: lib/model-families).
 */
import { useState } from "preact/hooks";
import { Link, useInRouterContext } from "react-router";
import { RefreshCw } from "lucide-preact";
import { THINKING_LEVELS, modelKey, parseModelKey, sameModel, type ModelInfo, type ModelRef, type ThinkingLevel } from "@glade/protocol";
import { Button, FormGroup, FormRow, SearchField, Select, Spinner, Switch, type SelectOption } from "@glade/app-core/ui";
import { cn } from "@glade/app-core/lib/cn";
import { routes } from "@glade/app-core/app/routes";
import { groupByFamily, modelMatches } from "@glade/app-core/lib/model-families";
import {
  hostAgentDefaults,
  hostAgentModels,
  hostDefaultHarness,
  hostHarnesses,
  hostModelsFor,
  hostQuickTasks,
  hostSettings,
  hostVisibleModelsFor,
  loadHostModels,
  updateHostAgentModels,
  updateHostSettings,
} from "@glade/app-core/state/host-settings";
import { modelGroup } from "@glade/app-core/features/chat/Pickers";

export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/** Group models by provider, or the harness's group label (I-175); groups and models sorted by name. */
export function groupModels(list: readonly ModelInfo[]): Array<[provider: string, models: ModelInfo[]]> {
  const map = new Map<string, ModelInfo[]>();
  for (const m of list) map.set(modelGroup(m), [...(map.get(modelGroup(m)) ?? []), m]);
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, ms]) => [p, ms.sort((a, b) => a.name.localeCompare(b.name))]);
}

/**
 * Models grouped by agent, then provider (I-155): `[["pi · anthropic", […]], …]`. `labelOf` names
 * a model's harness (`ModelInfo.harness`; older servers don't say, then it's the default one).
 */
export function groupModelsByAgent(list: readonly ModelInfo[], labelOf: (harness: string | undefined) => string): Array<[group: string, models: ModelInfo[]]> {
  const byAgent = new Map<string, ModelInfo[]>();
  for (const m of list) {
    const label = labelOf(m.harness);
    byAgent.set(label, [...(byAgent.get(label) ?? []), m]);
  }
  return [...byAgent.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([agent, ms]) => groupModels(ms).map(([provider, pms]) => [provider === agent ? agent : `${agent} · ${provider}`, pms] as [string, ModelInfo[]]));
}

/**
 * The thinking levels an agent's models support, in order (I-198: per agent); every level when it
 * lists no models or none says. `keep` (the stored value) is always included so it still shows.
 */
export function agentThinkingLevels(list: readonly ModelInfo[], keep?: ThinkingLevel | null): ThinkingLevel[] {
  const supported = new Set<ThinkingLevel>(list.flatMap((m) => m.thinkingLevels ?? []));
  if (supported.size === 0) return [...THINKING_LEVELS];
  if (keep) supported.add(keep);
  return THINKING_LEVELS.filter((l) => supported.has(l));
}

/** The model the server picks for quick tasks when it's listed (`DEFAULT_SMALL_MODEL`). */
const QUICK_DEFAULT = { provider: "anthropic", id: "claude-haiku-4-5" };

function modelOptions(list: readonly ModelInfo[], none: string, current?: ModelRef | null): SelectOption<string>[] {
  // A stored model that's hidden (or gone) still shows as the value.
  const extra = current && !list.some((m) => sameModel(m, current)) ? [{ value: modelKey(current), label: current.id, group: current.provider }] : [];
  return [
    { value: "", label: none },
    ...groupModels(list).flatMap(([provider, ms]) => ms.map((m) => ({ value: modelKey(m), label: m.name, group: provider }))),
    ...extra,
  ];
}

const nameIn = (list: readonly ModelInfo[], ref: ModelRef | null | undefined) => (ref ? (list.find((m) => sameModel(m, ref))?.name ?? ref.id) : null);

/** `<harness>/<provider>/<id>`: a quick-tasks option's value. */
export const quickTasksKey = (harness: string, model: ModelRef) => `${harness}/${modelKey(model)}`;
export function parseQuickTasksKey(key: string): { harness: string; model: ModelRef } | null {
  const slash = key.indexOf("/");
  const model = slash > 0 ? parseModelKey(key.slice(slash + 1)) : null;
  return model ? { harness: key.slice(0, slash), model } : null;
}

/**
 * The Glade-wide quick-tasks model (I-198): titles, `/name`, summaries, search and commit
 * messages, for chats of every agent. Options are grouped by agent (only agents that can run quick
 * tasks), plus Automatic, whose label says what it falls back to.
 */
export function QuickTasksRow() {
  const current = hostQuickTasks.value;
  const offered = (hostHarnesses.value ?? []).filter((h) => h.capabilities.quickTasks);
  const defaultAgent = hostDefaultHarness.value;
  const haiku = defaultAgent ? hostModelsFor(defaultAgent.id).find((m) => sameModel(m, QUICK_DEFAULT)) : undefined;
  const several = (hostHarnesses.value?.length ?? 0) > 1;
  const automatic = haiku && defaultAgent ? `Automatic (${several ? `${defaultAgent.label} · ` : ""}${haiku.name})` : "Automatic (the chat's model)";

  const options: SelectOption<string>[] = [{ value: "", label: automatic }];
  for (const h of offered) {
    const visible = hostVisibleModelsFor(h.id);
    for (const [provider, ms] of groupModels(visible)) {
      const group = provider === h.label ? h.label : `${h.label} · ${provider}`;
      for (const m of ms) options.push({ value: quickTasksKey(h.id, m), label: m.name, group });
    }
  }
  const value = current ? quickTasksKey(current.harness, current.model) : "";
  if (current && !options.some((o) => o.value === value)) {
    // Hidden, or its agent is off / can't run quick tasks any more: still show what's stored.
    const label = hostHarnesses.value?.find((h) => h.id === current.harness)?.label ?? current.harness;
    options.push({ value, label: nameIn(hostModelsFor(current.harness), current.model) ?? current.model.id, group: label });
  }

  return (
    <FormRow label="Quick tasks model" description="Names chats and writes summaries, search answers and commit messages, for chats of every agent. A small, fast model works best.">
      <Select
        aria-label="Quick tasks model"
        class="w-[240px]"
        value={value}
        options={options}
        onChange={(key) => void updateHostSettings({ models: { quickTasks: parseQuickTasksKey(key) } })}
      />
    </FormRow>
  );
}

/** The reason the Sub-agent model pickers are greyed out (I-221), with a link to the switch. */
function SubagentModelsOff() {
  const inRouter = useInRouterContext();
  return (
    <>
      Sub-agents use their chat's model.{" "}
      {inRouter ? (
        <Link to={routes.settingsSubagents()} class="text-accent hover:underline">
          Turn on “Use other models for sub-agents”
        </Link>
      ) : (
        "Turn on “Use other models for sub-agents”"
      )}{" "}
      in Settings → Sub-agents to choose one.
    </>
  );
}

/**
 * One agent's "Defaults" and "Models" groups (I-198): only its models, its own settings. The
 * Models list (I-207) has a filter box (name or id) and groups each provider's models by family
 * (`groupByFamily`: families A–Z, newest first, "N of M shown"; a model that is its own family has
 * no header). `readOnly` (another device) disables the settings; the filter still works.
 */
export function AgentModelGroups({ harness, readOnly = false }: { harness: string; readOnly?: boolean }) {
  const info = hostHarnesses.value?.find((h) => h.id === harness);
  const s = hostAgentModels(harness);
  const all = hostModelsFor(harness);
  const visible = hostVisibleModelsFor(harness);
  const hidden = new Set(s.hiddenModels);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const label = info?.label ?? harness;
  const caps = info?.capabilities;
  // I-050: name the agent's own default so "Default" isn't a mystery.
  const own = hostAgentDefaults(harness);
  const ownName = nameIn(all, own?.model);
  const levels = agentThinkingLevels(all, s.defaultThinkingLevel);
  const subLevels = agentThinkingLevels(all, s.subagentThinkingLevel);
  // I-221: with other models off, sub-agents always use their chat's model and thinking.
  const otherModels = hostSettings.value.agent?.subagentOtherModels === true;
  const set = (patch: Parameters<typeof updateHostAgentModels>[1]) => void updateHostAgentModels(harness, patch);
  const viewOnly = (children: preact.ComponentChildren, className?: string) => (
    <fieldset disabled={readOnly} class={cn("min-w-0", readOnly && "pointer-events-none", className)}>
      {children}
    </fieldset>
  );

  const refresh = async () => {
    setRefreshing(true);
    await loadHostModels(true);
    setRefreshing(false);
  };
  const setVisible = (key: string, show: boolean) => {
    const next = new Set(hidden);
    if (show) next.delete(key);
    else next.add(key);
    set({ hiddenModels: [...next] });
  };
  // Families are built from every model (so "N of M shown" counts the whole family), then filtered.
  const groups = groupModels(all)
    .map(([group, ms]) => ({
      group,
      families: groupByFamily(ms)
        .map((f) => ({ ...f, shown: f.models.filter((m) => !hidden.has(modelKey(m))).length, matching: f.models.filter((m) => modelMatches(m, query)) }))
        .filter((f) => f.matching.length > 0),
    }))
    .filter((g) => g.families.length > 0);
  const modelRow = (m: ModelInfo, inFamily: boolean) => {
    const key = modelKey(m);
    return (
      <div key={key} class={cn("flex h-8 items-center justify-between gap-3 border-t border-separator pr-3", inFamily ? "pl-6" : "pl-3")}>
        <div class="min-w-0 truncate">
          {m.name} <span class="ml-1 text-[0.85rem] text-fg-subtle">{m.id}</span>
        </div>
        <Switch size="sm" aria-label={`Show ${m.name}`} checked={!hidden.has(key)} onCheckedChange={(v) => setVisible(key, v)} />
      </div>
    );
  };

  return (
    <>
      {viewOnly(
        <FormGroup title="Defaults">
          <FormRow label="Default model" description={`Used for new ${label} chats.`}>
            <Select
              aria-label="Default model"
              class="w-[240px]"
              value={s.defaultModel ? modelKey(s.defaultModel) : ""}
              options={modelOptions(visible, ownName ? `Default (${ownName})` : "Agent default", s.defaultModel)}
              onChange={(key) => set({ defaultModel: parseModelKey(key) })}
            />
          </FormRow>
          <FormRow label="Default thinking level">
            <Select
              aria-label="Default thinking level"
              class="w-[240px]"
              value={s.defaultThinkingLevel}
              options={levels.map((l) => ({ value: l, label: THINKING_LABELS[l] }))}
              onChange={(defaultThinkingLevel) => set({ defaultThinkingLevel })}
            />
          </FormRow>
          {caps?.subagents !== false && (
            <>
              <FormRow
                label="Sub-agent model"
                description={otherModels ? "Model for agents started by a chat (spawn_agent). A cheaper model saves usage." : <SubagentModelsOff />}
              >
                <Select
                  aria-label="Sub-agent model"
                  disabled={!otherModels}
                  class="w-[240px]"
                  value={s.subagentModel ? modelKey(s.subagentModel) : ""}
                  options={modelOptions(visible, "Same as the parent chat", s.subagentModel)}
                  onChange={(key) => set({ subagentModel: parseModelKey(key) })}
                />
              </FormRow>
              <FormRow label="Sub-agent thinking">
                <Select
                  aria-label="Sub-agent thinking"
                  disabled={!otherModels}
                  class="w-[240px]"
                  value={s.subagentThinkingLevel ?? ""}
                  options={[{ value: "", label: "Same as the parent chat" }, ...subLevels.map((l) => ({ value: l, label: THINKING_LABELS[l] }))]}
                  onChange={(level) => set({ subagentThinkingLevel: (level || null) as ThinkingLevel | null })}
                />
              </FormRow>
            </>
          )}
          {caps?.sideQuestions !== false && (
            <FormRow label="Side questions model" description="Answers side questions (/btw, Ask Aside) while the agent works. A faster model answers sooner.">
              <Select
                aria-label="Side questions model"
                class="w-[240px]"
                value={s.sideQuestionModel ? modelKey(s.sideQuestionModel) : ""}
                options={modelOptions(visible, "Same as the chat", s.sideQuestionModel)}
                onChange={(key) => set({ sideQuestionModel: parseModelKey(key) })}
              />
            </FormRow>
          )}
        </FormGroup>,
      )}

      <FormGroup
        title="Models"
        footer={`The models ${label} can use, by provider and family, newest first. Hidden models don't appear in its model picker.`}
        actions={
          <Button size="sm" onClick={() => void refresh()} disabled={refreshing || readOnly}>
            {refreshing ? <Spinner size={12} /> : <RefreshCw size={12} />}
            Refresh Models
          </Button>
        }
      >
        {all.length === 0 ? (
          <FormRow label={<span class="text-fg-muted">{refreshing ? "Loading models…" : `No models found. Check that ${label} is configured with a provider.`}</span>} />
        ) : (
          <>
            <div class="px-3 py-2">
              <SearchField aria-label="Filter models" placeholder="Filter models" value={query} onValueChange={setQuery} />
            </div>
            {groups.length === 0 ? (
              <FormRow label={<span class="text-fg-muted">No models match “{query.trim()}”.</span>} />
            ) : (
              viewOnly(
                groups.map(({ group, families }) => (
                  <div key={group}>
                    <div class="px-3 pt-2 pb-1 text-[0.85rem] font-semibold text-fg-muted">{group}</div>
                    {families.map((f) =>
                      // A model that is its own family ("Daybreak Blue") needs no header above it.
                      f.models.length === 1 && f.family.toLowerCase() === f.models[0]!.name.toLowerCase() ? (
                        modelRow(f.models[0]!, false)
                      ) : (
                        <div key={f.key} role="group" aria-label={f.family}>
                          <div class="flex h-7 items-center justify-between gap-3 border-t border-separator px-3 text-[0.92rem] select-none">
                            <span class="min-w-0 truncate font-medium text-fg">{f.family}</span>
                            <span class="shrink-0 text-fg-subtle">
                              {f.shown} of {f.models.length} shown
                            </span>
                          </div>
                          {f.matching.map((m) => modelRow(m, true))}
                        </div>
                      ),
                    )}
                  </div>
                )),
                "divide-y divide-separator",
              )
            )}
          </>
        )}
      </FormGroup>
    </>
  );
}
