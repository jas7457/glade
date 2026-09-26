import { useState } from "preact/hooks";
import { RefreshCw } from "lucide-preact";
import { THINKING_LEVELS, modelKey, parseModelKey, type ModelInfo, type ThinkingLevel } from "@pi-ui/protocol";
import { Button, FormGroup, FormRow, Select, Spinner, Switch, type SelectOption } from "@/ui";
import { loadModels, models, settings, visibleModels } from "@/state/store";
import { updateSettings } from "@/state/actions";

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
            options={modelOptions(visible, "Agent default")}
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
        <FormRow label="Title model" description="Model used to name chats. A small, fast model works best.">
          <Select
            aria-label="Title model"
            class="w-[240px]"
            value={s.titleModel ? modelKey(s.titleModel) : ""}
            options={modelOptions(visible, "Same as the chat")}
            onChange={(key) => void updateSettings({ models: { titleModel: parseModelKey(key) } })}
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
          <FormRow label={<span class="text-fg-muted">{refreshing ? "Loading models…" : "No models found. Check that pi is configured with a provider."}</span>} />
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
