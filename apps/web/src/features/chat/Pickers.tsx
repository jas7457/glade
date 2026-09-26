/**
 * Composer toolbar pickers: model (grouped by provider) and thinking level.
 * Controlled components; the composer decides what a change means (API call or local state).
 */
import { Brain, ChevronDown } from "lucide-preact";
import { sameModel, type ModelInfo, type ModelRef, type ThinkingLevel } from "@pi-ui/protocol";
import { cn } from "@/lib/cn";
import { Menu, MenuCheckItem, MenuLabel, MenuSeparator } from "@/ui";
import { thinkingLabel } from "./composer-utils";

const triggerClass =
  "inline-flex h-6 max-w-[220px] items-center gap-1 rounded-control px-1.5 text-[0.92rem] text-fg-muted outline-none hover:bg-hover hover:text-fg data-[state=open]:bg-selected data-[state=open]:text-fg disabled:opacity-40";

export interface ModelPickerProps {
  value: ModelRef | null;
  models: ModelInfo[];
  onChange: (model: ModelRef) => void;
  disabled?: boolean;
}

export function ModelPicker({ value, models, onChange, disabled }: ModelPickerProps) {
  const current = models.find((m) => sameModel(m, value));
  const label = current?.name ?? value?.id ?? (models.length ? "Select model" : "Loading models…");
  const providers = new Map<string, ModelInfo[]>();
  for (const m of models) providers.set(m.provider, [...(providers.get(m.provider) ?? []), m]);

  return (
    <Menu
      side="top"
      contentClass="max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] min-w-[240px]"
      trigger={
        <button type="button" class={triggerClass} disabled={disabled || models.length === 0} aria-label="Model">
          <span class="truncate">{label}</span>
          <ChevronDown size={11} strokeWidth={2.5} class="shrink-0 opacity-70" />
        </button>
      }
    >
      {[...providers.entries()].map(([provider, list], i) => (
        <div key={provider}>
          {i > 0 && <MenuSeparator />}
          <MenuLabel>{provider}</MenuLabel>
          {list.map((m) => (
            <MenuCheckItem key={`${m.provider}/${m.id}`} checked={sameModel(m, value)} onSelect={() => onChange({ provider: m.provider, id: m.id })}>
              {m.name}
            </MenuCheckItem>
          ))}
        </div>
      ))}
    </Menu>
  );
}

export interface ThinkingPickerProps {
  value: ThinkingLevel;
  levels: ThinkingLevel[];
  onChange: (level: ThinkingLevel) => void;
  disabled?: boolean;
}

/** Hidden when the model doesn't reason (levels empty or exactly ["off"]). */
export function ThinkingPicker({ value, levels, onChange, disabled }: ThinkingPickerProps) {
  if (levels.length === 0 || (levels.length === 1 && levels[0] === "off")) return null;
  return (
    <Menu
      side="top"
      trigger={
        <button type="button" class={triggerClass} disabled={disabled} aria-label="Thinking level">
          <Brain size={12} class={cn("shrink-0", value === "off" && "opacity-50")} />
          <span class="truncate">{thinkingLabel(value)}</span>
          <ChevronDown size={11} strokeWidth={2.5} class="shrink-0 opacity-70" />
        </button>
      }
    >
      <MenuLabel>Thinking</MenuLabel>
      {levels.map((level) => (
        <MenuCheckItem key={level} checked={level === value} onSelect={() => onChange(level)}>
          {thinkingLabel(level)}
        </MenuCheckItem>
      ))}
    </Menu>
  );
}
