/**
 * macOS toggle switch (Radix Switch). Pass `label` to render it as a labelled row.
 */
import * as RadixSwitch from "@radix-ui/react-switch";
import { useId } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { cn } from "@/lib/cn";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  id?: string;
  /** Accessible label (when there is no visible label). */
  "aria-label"?: string;
  class?: string;
}

export function Switch({ checked, onCheckedChange, disabled, size = "md", id, class: className, ...rest }: SwitchProps) {
  const sm = size === "sm";
  return (
    <RadixSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={rest["aria-label"]}
      class={cn(
        "relative inline-flex shrink-0 items-center rounded-full p-[2px] outline-none transition-colors duration-150",
        "bg-[color-mix(in_srgb,var(--pi-fg)_15%,transparent)] data-[state=checked]:bg-accent disabled:opacity-40",
        "shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.08)]",
        sm ? "h-4 w-[26px]" : "h-[22px] w-[38px]",
        className,
      )}
    >
      <RadixSwitch.Thumb
        class={cn(
          "block rounded-full bg-white shadow-[0_0_0_0.5px_rgb(0_0_0/0.1),0_1px_2px_rgb(0_0_0/0.25)] transition-transform duration-150",
          sm ? "size-3 data-[state=checked]:translate-x-[10px]" : "size-[18px] data-[state=checked]:translate-x-4",
        )}
      />
    </RadixSwitch.Root>
  );
}

export interface SwitchFieldProps extends Omit<SwitchProps, "id" | "aria-label"> {
  label: ComponentChildren;
  description?: ComponentChildren;
}

/** Label (+ optional description) on the left, switch on the right. */
export function SwitchField({ label, description, class: className, ...props }: SwitchFieldProps) {
  const id = useId();
  return (
    <div class={cn("flex items-center justify-between gap-4", className)}>
      <div class="min-w-0">
        <label for={id} class="block text-fg">
          {label}
        </label>
        {description && <div class="mt-0.5 text-[0.92rem] text-fg-muted">{description}</div>}
      </div>
      <Switch id={id} {...props} />
    </div>
  );
}
