/**
 * A row of small square choices (a radio group): colour swatches, icon pickers. Arrow keys move
 * between choices (roving focus), the selected one has an accent ring.
 *
 *   <ChoiceGrid aria-label="Colour" value={color} onChange={setColor}
 *     options={[{ value: "", label: "None", content: <Ban /> }, { value: "teal", label: "Teal", content: <Dot /> }]} />
 */
import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import { cn } from "@glade/app-core/lib/cn";

export interface ChoiceGridOption<T extends string> {
  value: T;
  /** Accessible name and tooltip. */
  label: string;
  content: ComponentChildren;
  /** Extra attributes for the button (e.g. `data-agent-color`). */
  attrs?: Record<string, string>;
}

export interface ChoiceGridProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly ChoiceGridOption<T>[];
  disabled?: boolean;
  "aria-label": string;
  class?: string;
}

export function ChoiceGrid<T extends string>({ value, onChange, options, disabled, class: className, ...rest }: ChoiceGridProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const move = (index: number) => {
    const next = options[(index + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    ref.current?.querySelectorAll<HTMLElement>("[role=radio]")[(index + options.length) % options.length]?.focus();
  };
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div ref={ref} role="radiogroup" aria-label={rest["aria-label"]} class={cn("flex flex-wrap gap-1", className)}>
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={o.label}
            title={o.label}
            disabled={disabled}
            tabIndex={i === selectedIndex ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") (e.preventDefault(), move(i + 1));
              else if (e.key === "ArrowLeft" || e.key === "ArrowUp") (e.preventDefault(), move(i - 1));
            }}
            {...o.attrs}
            class={cn(
              "flex size-7 items-center justify-center rounded-[6px] text-fg-muted outline-none hover:bg-hover disabled:opacity-50 [&_svg]:size-3.5",
              "focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--pi-accent)_45%,transparent)]",
              selected && "bg-selected text-fg shadow-[inset_0_0_0_1.5px_var(--pi-accent)]",
            )}
          >
            {o.content}
          </button>
        );
      })}
    </div>
  );
}
