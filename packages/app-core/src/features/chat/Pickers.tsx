/**
 * Composer toolbar pickers: model (grouped by provider) and thinking level.
 * Controlled components; the composer decides what a change means (API call or local state).
 * Inside an `OptionSheetContext` (the iPhone app, I-164) they open as bottom sheets instead of
 * popover menus.
 */
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { Brain, ChevronDown } from "lucide-preact";
import { sameModel, type ModelInfo, type ModelRef, type ThinkingLevel } from "@glade/protocol";
import { cn } from "@glade/app-core/lib/cn";
import { Menu, MenuCheckItem, MenuLabel, MenuSeparator } from "@glade/app-core/ui";
import { thinkingLabel } from "./composer-utils";
import { useOptionSheet, type OptionSheetSection } from "./option-sheet";

const triggerClass =
  "inline-flex h-6 max-w-[220px] items-center gap-1 rounded-control px-1.5 text-[0.92rem] text-fg-muted outline-none hover:bg-hover hover:text-fg data-[state=open]:bg-selected data-[state=open]:text-fg disabled:opacity-40";

/** Touch (the sheet variant): a compact pill, so model + thinking fit one row on a phone. */
const touchTriggerClass = "h-8 max-w-[10.5rem] shrink rounded-full px-2.5 text-[0.85rem]";

/**
 * The sheet form of a picker: `trigger` opens a sheet with `sections`; picking closes it. Open
 * state is controlled when `open` is given (e.g. `/model`), local otherwise.
 */
export function SheetPicker({
  title,
  trigger,
  sections,
  open,
  onOpenChange,
}: {
  title: string;
  trigger: (open: () => void) => ComponentChildren;
  sections: OptionSheetSection[];
} & Pick<PickerOpenProps, "open" | "onOpenChange">) {
  const SheetImpl = useOptionSheet();
  const [localOpen, setLocalOpen] = useState(false);
  const isOpen = open ?? localOpen;
  const setOpen = (value: boolean) => {
    onOpenChange?.(value);
    if (open === undefined) setLocalOpen(value);
  };
  const close = () => setOpen(false);
  return (
    <>
      {trigger(() => setOpen(true))}
      {SheetImpl && (
        <SheetImpl
          open={isOpen}
          onClose={close}
          title={title}
          sections={sections.map((section) => ({
            ...section,
            items: section.items.map((item) => ({
              ...item,
              onSelect: () => {
                close();
                item.onSelect();
              },
            })),
          }))}
        />
      )}
    </>
  );
}

/** Optional control over the menu (e.g. to open it from the `/model` command). */
export interface PickerOpenProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (e: Event) => void;
}

export interface ModelPickerProps extends PickerOpenProps {
  value: ModelRef | null;
  models: ModelInfo[];
  onChange: (model: ModelRef) => void;
  disabled?: boolean;
}

export function ModelPicker({ value, models, onChange, disabled, open, onOpenChange, onCloseAutoFocus }: ModelPickerProps) {
  const current = models.find((m) => sameModel(m, value));
  const label = current?.name ?? value?.id ?? (models.length ? "Select model" : "Loading models…");
  const providers = new Map<string, ModelInfo[]>();
  for (const m of models) providers.set(m.provider, [...(providers.get(m.provider) ?? []), m]);
  const sheet = useOptionSheet();
  const triggerButton = (onClick?: () => void) => (
    <button type="button" class={cn(triggerClass, sheet && touchTriggerClass)} disabled={disabled || models.length === 0} aria-label="Model" onClick={onClick}>
      <span class="truncate">{label}</span>
      <ChevronDown size={11} strokeWidth={2.5} class="shrink-0 opacity-70" />
    </button>
  );

  if (sheet) {
    return (
      <SheetPicker
        title="Model"
        open={open}
        onOpenChange={onOpenChange}
        trigger={triggerButton}
        sections={[...providers.entries()].map(([provider, list]) => ({
          title: provider,
          items: list.map((m) => ({
            key: `${m.provider}/${m.id}`,
            label: m.name,
            checked: sameModel(m, value),
            onSelect: () => onChange({ provider: m.provider, id: m.id }),
          })),
        }))}
      />
    );
  }

  return (
    <Menu
      side="top"
      open={open}
      onOpenChange={onOpenChange}
      onCloseAutoFocus={onCloseAutoFocus}
      contentClass="max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] min-w-[240px]"
      trigger={triggerButton()}
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

export interface ThinkingPickerProps extends PickerOpenProps {
  value: ThinkingLevel;
  levels: ThinkingLevel[];
  onChange: (level: ThinkingLevel) => void;
  disabled?: boolean;
}

/** Hidden when the model doesn't reason (levels empty or exactly ["off"]). */
export function ThinkingPicker({ value, levels, onChange, disabled, open, onOpenChange, onCloseAutoFocus }: ThinkingPickerProps) {
  const sheet = useOptionSheet();
  if (levels.length === 0 || (levels.length === 1 && levels[0] === "off")) return null;
  const triggerButton = (onClick?: () => void) => (
    <button type="button" class={cn(triggerClass, sheet && touchTriggerClass)} disabled={disabled} aria-label="Thinking level" onClick={onClick}>
      <Brain size={12} class={cn("shrink-0", value === "off" && "opacity-50")} />
      <span class="truncate">{thinkingLabel(value)}</span>
      <ChevronDown size={11} strokeWidth={2.5} class="shrink-0 opacity-70" />
    </button>
  );
  if (sheet) {
    return (
      <SheetPicker
        title="Thinking"
        open={open}
        onOpenChange={onOpenChange}
        trigger={triggerButton}
        sections={[{ items: levels.map((level) => ({ key: level, label: thinkingLabel(level), checked: level === value, onSelect: () => onChange(level) })) }]}
      />
    );
  }
  return (
    <Menu
      side="top"
      open={open}
      onOpenChange={onOpenChange}
      onCloseAutoFocus={onCloseAutoFocus}
      trigger={triggerButton()}
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

export interface ModelThinkingPickerProps extends PickerOpenProps {
  model: ModelRef | null;
  models: ModelInfo[];
  onModelChange: (model: ModelRef) => void;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  onThinkingChange: (level: ThinkingLevel) => void;
  disabled?: boolean;
  /**
   * Sheet only (the iPhone's new chat, I-166): the agent choice as a third section; `label` =
   * the current agent.
   */
  agents?: { label: string; section: OptionSheetSection } | null;
  /** The agent chooses its own model (I-119): no Model/Thinking; the pill shows the agent. Needs `agents`. */
  hideModel?: boolean;
}

/**
 * Touch (the iPhone app, I-164): model and thinking level behind **one** pill ("Opus · Medium")
 * that opens one sheet with a Model section (per provider when there are several) and a
 * Thinking section (and an Agent section when `agents` is given, I-166). Sheet-only: without an
 * `OptionSheetContext` it renders the two menus.
 */
export function ModelThinkingPicker(props: ModelThinkingPickerProps) {
  const { model, models, onModelChange, thinkingLevel, thinkingLevels, onThinkingChange, disabled, open, onOpenChange, agents } = props;
  const sheet = useOptionSheet();
  if (sheet && agents && props.hideModel) {
    return (
      <SheetPicker
        title="Agent"
        open={open}
        onOpenChange={onOpenChange}
        trigger={(onClick) => (
          <button type="button" class={cn(triggerClass, touchTriggerClass, "max-w-[14rem]")} disabled={disabled} aria-label={`Agent: ${agents.label}`} onClick={onClick}>
            <span class="truncate">{agents.label}</span>
            <ChevronDown size={11} strokeWidth={2.5} class="shrink-0 opacity-70" />
          </button>
        )}
        sections={[agents.section]}
      />
    );
  }
  if (!sheet) {
    return (
      <>
        <ModelPicker value={model} models={models} onChange={onModelChange} disabled={disabled} />
        <ThinkingPicker value={thinkingLevel} levels={thinkingLevels} onChange={onThinkingChange} disabled={disabled} />
      </>
    );
  }
  const current = models.find((m) => sameModel(m, model));
  const modelLabel = current?.name ?? model?.id ?? (models.length ? "Select model" : "Loading models…");
  const thinks = !(thinkingLevels.length === 0 || (thinkingLevels.length === 1 && thinkingLevels[0] === "off"));
  const providers = new Map<string, ModelInfo[]>();
  for (const m of models) providers.set(m.provider, [...(providers.get(m.provider) ?? []), m]);
  const several = providers.size > 1;
  const sections: OptionSheetSection[] = [...providers.entries()].map(([provider, list]) => ({
    title: several ? `Model · ${provider}` : "Model",
    items: list.map((m) => ({
      key: `${m.provider}/${m.id}`,
      label: m.name,
      checked: sameModel(m, model),
      onSelect: () => onModelChange({ provider: m.provider, id: m.id }),
    })),
  }));
  if (thinks) {
    sections.push({
      title: "Thinking",
      items: thinkingLevels.map((level) => ({ key: `thinking/${level}`, label: thinkingLabel(level), checked: level === thinkingLevel, onSelect: () => onThinkingChange(level) })),
    });
  }
  if (agents) sections.push(agents.section);
  return (
    <SheetPicker
      title={thinks ? "Model & Thinking" : "Model"}
      open={open}
      onOpenChange={onOpenChange}
      trigger={(onClick) => (
        <button
          type="button"
          class={cn(triggerClass, touchTriggerClass, "max-w-[14rem]")}
          disabled={disabled || (models.length === 0 && !agents)}
          aria-label={thinks ? `Model and thinking: ${modelLabel}, ${thinkingLabel(thinkingLevel)}` : `Model: ${modelLabel}`}
          onClick={onClick}
        >
          <span class="truncate">{modelLabel}</span>
          {thinks && (
            <>
              <span class="shrink-0 opacity-50">·</span>
              <Brain size={12} class={cn("shrink-0", thinkingLevel === "off" && "opacity-50")} />
              <span class="shrink-0">{thinkingLabel(thinkingLevel)}</span>
            </>
          )}
          <ChevronDown size={11} strokeWidth={2.5} class="shrink-0 opacity-70" />
        </button>
      )}
      sections={sections}
    />
  );
}
