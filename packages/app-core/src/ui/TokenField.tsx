/**
 * A list of short values as removable tokens with a text field after them (like macOS token
 * fields): Enter or a comma adds what's typed, Backspace in an empty field removes the last
 * token, blur adds a pending value. Duplicates (case-insensitive) are ignored.
 *
 *   <TokenField aria-label="Nicknames" values={names} onChange={setNames} placeholder="Add a name" max={12} />
 */
import { useState } from "preact/hooks";
import { X } from "lucide-preact";
import { cn } from "@glade/app-core/lib/cn";

export interface TokenFieldProps {
  values: readonly string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  /** Most tokens allowed (the field hides when reached). */
  max?: number;
  /** Placeholder-like tokens shown greyed when there are no values (inherited ones). */
  inherited?: readonly string[];
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  class?: string;
}

export function TokenField({ values, onChange, placeholder, max, inherited, disabled, id, class: className, ...rest }: TokenFieldProps) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const parts = raw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const next = [...values];
    for (const p of parts) if (!next.some((v) => v.toLowerCase() === p.toLowerCase()) && (max === undefined || next.length < max)) next.push(p);
    if (next.length !== values.length) onChange(next);
    setDraft("");
  };
  const full = max !== undefined && values.length >= max;
  const label = rest["aria-label"] ?? "Values";
  return (
    <div
      role="group"
      aria-label={label}
      class={cn(
        "flex min-h-7 w-full flex-wrap items-center gap-1 rounded-[5px] bg-control px-1 py-[3px]",
        "shadow-[0_0_0_0.5px_var(--pi-separator),inset_0_0.5px_1px_rgb(0_0_0/0.06)]",
        "focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--pi-accent)_45%,transparent)]",
        disabled && "opacity-50",
        className,
      )}
    >
      {values.length === 0 &&
        inherited?.map((v) => (
          <span key={`inherited-${v}`} class="inline-flex h-5 items-center rounded-[4px] border-[0.5px] border-dashed border-separator px-1.5 text-[0.92rem] text-fg-subtle select-none">
            {v}
          </span>
        ))}
      {values.map((v) => (
        <span key={v} class="inline-flex h-5 max-w-[200px] items-center gap-0.5 rounded-[4px] bg-selected pr-0.5 pl-1.5 text-[0.92rem] text-fg select-none">
          <span class="min-w-0 truncate">{v}</span>
          <button
            type="button"
            disabled={disabled}
            aria-label={`Remove ${v}`}
            onClick={() => onChange(values.filter((x) => x !== v))}
            class="flex size-4 shrink-0 items-center justify-center rounded-[3px] text-fg-subtle hover:bg-hover hover:text-fg"
          >
            <X size={10} strokeWidth={2.5} />
          </button>
        </span>
      ))}
      {!full && (
        <input
          id={id}
          type="text"
          spellcheck={false}
          autocomplete="off"
          disabled={disabled}
          aria-label={`Add to ${label}`}
          value={draft}
          placeholder={values.length === 0 && !inherited?.length ? placeholder : undefined}
          onInput={(e) => {
            const v = e.currentTarget.value;
            if (v.includes(",")) add(v);
            else setDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (draft.trim()) add(draft);
            } else if (e.key === "Backspace" && draft === "" && values.length) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={() => draft.trim() && add(draft)}
          class="h-5 min-w-[80px] flex-1 bg-transparent px-1 text-[1rem] text-fg outline-none placeholder:text-fg-subtle"
        />
      )}
    </div>
  );
}
