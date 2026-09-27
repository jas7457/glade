import { useState } from "preact/hooks";
import { RefreshCw } from "lucide-preact";
import { THINKING_LEVELS, modelKey, parseModelKey, type ModelInfo, type ThinkingLevel } from "@glade/protocol";
import { Button, FormGroup, FormRow, Select, Spinner, Switch, type SelectOption } from "@/ui";
import { harnessDefaults, loadModels, models, settings, visibleModels } from "@/state/store";
import { updateSettings } from "@/state/actions";
import { harnessLabel } from "@/state/harnesses";

export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/** Group models by provider (providers and models sorted by name). */
export function groupModels(list: readonly ModelInfo[]): Array<[provider: string, models: ModelInfo[]]> {
  const map = new Map<string, ModelInfo[]>();
  for (const m of list) map.set(m.provider, [...(map.get(m.provider) ?? []), m]);
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, ms]) => [p, ms.sort((a, b) => a.name.localeCompare(b.name))]);
}

/** The server's default small model when it's available (`DEFAULT_SMALL_MODEL`). */
const SMALL_DEFAULT = { provider: "anthropic", id: "claude-haiku-4-5" };

function modelOptions(list: readonly ModelInfo[], none: string): SelectOption<string>[] {
  return [
    { value: "", label: none },
    ...groupModels(list).flatMap(([provider, ms]) => ms.map((m) => ({ value: modelKey(m), label: m.name, group: provider }))),
  ];
}

export function ModelSettings() {
  const s = settings.value.models;
  const all = models.value;
  const visible = visibleModels.value;
  const hidden = new Set(s.hiddenModels);
  const [refreshing, setRefreshing] = useState(false);
  // I-074: the server picks Haiku for quick tasks when it's listed, else the chat's model.
  const smallDefault = all.find((m) => m.provider === SMALL_DEFAULT.provider && m.id === SMALL_DEFAULT.id);
  // I-050: name the harness's own default so "Default" isn't a mystery.
  const harnessModel = harnessDefaults.value?.model;
  const harnessModelName = harnessModel ? (all.find((m) => m.provider === harnessModel.provider && m.id === harnessModel.id)?.name ?? harnessModel.id) : null;

  const refresh = async () => {
    setRefreshing(true);
    await loadModels(true);
    setRefreshing(false);
  };
  const setVisible = (key: string, show: boolean) => {
    const next = new Set(hidden);
    if (show) next.delete(key);
    else next.add(key);
    void updateSettings({ models: { hiddenModels: [...next] } });
  };

  return (
    <>
      <FormGroup title="Defaults">
        <FormRow label="Default model" description="Used for new chats.">
          <Select
            aria-label="Default model"
            class="w-[240px]"
            value={s.defaultModel ? modelKey(s.defaultModel) : ""}
            options={modelOptions(visible, harnessModelName ? `Default (${harnessModelName})` : "Agent default")}
            onChange={(key) => void updateSettings({ models: { defaultModel: parseModelKey(key) } })}
          />
        </FormRow>
        <FormRow label="Default thinking level">
          <Select
            aria-label="Default thinking level"
            class="w-[240px]"
            value={s.defaultThinkingLevel}
            options={THINKING_LEVELS.map((l) => ({ value: l, label: THINKING_LABELS[l] }))}
            onChange={(defaultThinkingLevel) => void updateSettings({ models: { defaultThinkingLevel } })}
          />
        </FormRow>
        <FormRow label="Small model" description="Used for quick tasks: naming chats, summaries and search. A small, fast model works best.">
          <Select
            aria-label="Small model"
            class="w-[240px]"
            value={s.smallModel ? modelKey(s.smallModel) : ""}
            options={modelOptions(visible, smallDefault ? `Default (${smallDefault.name})` : "Same as the chat")}
            onChange={(key) => void updateSettings({ models: { smallModel: parseModelKey(key) } })}
          />
        </FormRow>
      </FormGroup>

      <FormGroup title="Sub-agents">
        <FormRow label="Sub-agent model" description="Model for agents started by a chat (spawn_agent). A cheaper model saves usage.">
          <Select
            aria-label="Sub-agent model"
            class="w-[240px]"
            value={s.subagentModel ? modelKey(s.subagentModel) : ""}
            options={modelOptions(visible, "Same as the parent chat")}
            onChange={(key) => void updateSettings({ models: { subagentModel: parseModelKey(key) } })}
          />
        </FormRow>
        <FormRow label="Sub-agent thinking">
          <Select
            aria-label="Sub-agent thinking"
            class="w-[240px]"
            value={s.subagentThinkingLevel ?? ""}
            options={[{ value: "", label: "Same as the parent chat" }, ...THINKING_LEVELS.map((l) => ({ value: l, label: THINKING_LABELS[l] }))]}
            onChange={(level) => void updateSettings({ models: { subagentThinkingLevel: (level || null) as ThinkingLevel | null } })}
          />
        </FormRow>
      </FormGroup>

      <FormGroup
        title="Available models"
        footer="Hidden models don't appear in the model picker."
        actions={
          <Button size="sm" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? <Spinner size={12} /> : <RefreshCw size={12} />}
            Refresh Models
          </Button>
        }
      >
        {all.length === 0 ? (
          <FormRow label={<span class="text-fg-muted">{refreshing ? "Loading models…" : `No models found. Check that ${harnessLabel()} is configured with a provider.`}</span>} />
        ) : (
          groupModels(all).map(([provider, ms]) => (
            <div key={provider}>
              <div class="px-3 pt-2 pb-1 text-[0.85rem] font-semibold text-fg-muted">{provider}</div>
              {ms.map((m) => {
                const key = modelKey(m);
                return (
                  <div key={key} class="flex h-8 items-center justify-between gap-3 border-t border-separator px-3">
                    <div class="min-w-0 truncate">
                      {m.name} <span class="ml-1 text-[0.85rem] text-fg-subtle">{m.id}</span>
                    </div>
                    <Switch size="sm" aria-label={`Show ${m.name}`} checked={!hidden.has(key)} onCheckedChange={(v) => setVisible(key, v)} />
                  </div>
                );
              })}
            </div>
          ))
        )}
      </FormGroup>
    </>
  );
}
