/**
 * macOS segmented control (single selection).
 *
 *   <SegmentedControl value={theme} onChange={setTheme}
 *     options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
 */
import type { ComponentChildren } from "preact";
import { cn } from "@/lib/cn";

export interface SegmentOption<T extends string> {
  value: T;
  label: ComponentChildren;
  /** Accessible label when `label` is only an icon. */
  title?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentOption<T>[];
  size?: "sm" | "md";
  /** Stretch segments to fill the width. */
  fill?: boolean;
  class?: string;
  "aria-label"?: string;
}

export function SegmentedControl<T extends string>({ value, onChange, options, size = "md", fill, class: className, ...rest }: SegmentedControlProps<T>) {
  const move = (dir: 1 | -1) => {
    const enabled = options.filter((o) => !o.disabled);
    const idx = enabled.findIndex((o) => o.value === value);
    const next = enabled[(idx + dir + enabled.length) % enabled.length];
    if (next) onChange(next.value);
  };
  return (
    <div
      role="radiogroup"
      aria-label={rest["aria-label"]}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") (e.preventDefault(), move(1));
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") (e.preventDefault(), move(-1));
      }}
      class={cn(
        "inline-flex items-stretch gap-px rounded-[6px] bg-[color-mix(in_srgb,var(--pi-fg)_7%,transparent)] p-[2px]",
        size === "sm" ? "h-[22px]" : "h-7",
        fill && "flex w-full",
        className,
      )}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={o.title}
            title={o.title}
            disabled={o.disabled}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            class={cn(
              "inline-flex min-w-0 items-center justify-center gap-1 rounded-[4px] px-2.5 text-[0.92rem] whitespace-nowrap text-fg-muted outline-none disabled:opacity-40 [&_svg]:size-3.5",
              "focus-visible:ring-2 focus-visible:ring-accent/50",
              fill && "flex-1",
              selected
                ? "bg-control font-medium text-fg shadow-[0_0_0_0.5px_rgb(0_0_0/0.08),0_1px_2px_rgb(0_0_0/0.12)] dark:bg-white/20"
                : "hover:text-fg",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
