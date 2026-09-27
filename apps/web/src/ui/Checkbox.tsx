/**
 * macOS-style checkbox (a native input tinted with the accent colour). Supports the mixed state
 * for "select all" headers.
 *
 *   <Checkbox checked={on} onCheckedChange={setOn} aria-label="Include a.ts" />
 */
import { useEffect, useRef } from "preact/hooks";
import { cn } from "@/lib/cn";

export interface CheckboxProps {
  checked: boolean;
  /** Shown as "some selected" (−). */
  indeterminate?: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
  title?: string;
  class?: string;
}

export function Checkbox({ checked, indeterminate = false, onCheckedChange, disabled, title, class: className, ...rest }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      title={title}
      aria-label={rest["aria-label"]}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onCheckedChange((e.currentTarget as HTMLInputElement).checked)}
      class={cn(
        "m-0 size-3.5 shrink-0 accent-[var(--pi-accent)] outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40",
        className,
      )}
    />
  );
}
