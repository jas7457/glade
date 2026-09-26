/**
 * Pop-up button (like NSPopUpButton): shows the current value with ⌃⌄ chevrons and opens a menu
 * of checkable options. Options with a `group` are shown under a section label.
 *
 *   <Select value={v} onChange={setV} options={[{ value: "a", label: "Alpha" }]} />
 */
import type { ComponentChildren } from "preact";
import { ChevronsUpDown } from "lucide-preact";
import { cn } from "@/lib/cn";
import { Menu, MenuCheckItem, MenuLabel, MenuSeparator } from "./Menu";

export interface SelectOption<T extends string> {
  value: T;
  label: ComponentChildren;
  /** Secondary, right-aligned text in the menu. */
  detail?: ComponentChildren;
  /** Section header; consecutive options with the same group are listed together. */
  group?: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string> {
  value: T | null;
  onChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  /** Shown when `value` doesn't match any option. */
  placeholder?: ComponentChildren;
  disabled?: boolean;
  size?: "sm" | "md";
  /** Borderless variant for toolbars/composers. */
  variant?: "bordered" | "plain";
  class?: string;
  contentClass?: string;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom";
  "aria-label"?: string;
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled,
  size = "md",
  variant = "bordered",
  class: className,
  contentClass,
  align = "start",
  side = "bottom",
  ...rest
}: SelectProps<T>) {
  const current = options.find((o) => o.value === value);
  const items: ComponentChildren[] = [];
  let group: string | undefined;
  options.forEach((o, i) => {
    if (o.group !== group) {
      if (i > 0) items.push(<MenuSeparator key={`sep-${i}`} />);
      if (o.group) items.push(<MenuLabel key={`label-${i}`}>{o.group}</MenuLabel>);
      group = o.group;
    }
    items.push(
      <MenuCheckItem key={o.value} checked={o.value === value} disabled={o.disabled} detail={o.detail} onSelect={() => onChange(o.value)}>
        {o.label}
      </MenuCheckItem>,
    );
  });

  return (
    <Menu
      align={align}
      side={side}
      contentClass={contentClass}
      trigger={
        <button
          type="button"
          disabled={disabled}
          aria-label={rest["aria-label"]}
          aria-haspopup="menu"
          class={cn(
            "inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-[5px] pr-1 pl-2 text-left text-[1rem] text-fg outline-none disabled:opacity-40",
            size === "sm" ? "h-[22px] text-[0.92rem]" : "h-7",
            variant === "bordered"
              ? "bg-control shadow-[0_0_0_0.5px_var(--pi-separator),0_1px_1px_rgb(0_0_0/0.06)] active:bg-hover data-[state=open]:bg-hover"
              : "text-fg-muted hover:bg-hover hover:text-fg data-[state=open]:bg-selected",
            className,
          )}
        >
          <span class={cn("min-w-0 flex-1 truncate", !current && "text-fg-muted")}>{current ? current.label : placeholder}</span>
          <ChevronsUpDown size={12} class="shrink-0 opacity-60" />
        </button>
      }
    >
      {items}
    </Menu>
  );
}
