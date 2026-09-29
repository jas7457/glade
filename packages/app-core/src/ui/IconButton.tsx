import type { ComponentChildren, JSX } from "preact";
import { forwardRef } from "preact/compat";
import { cn } from "@glade/app-core/lib/cn";
import { Tooltip } from "./Tooltip";

export interface IconButtonProps extends Omit<JSX.HTMLAttributes<HTMLButtonElement>, "size" | "label"> {
  /** Accessible label; also shown as a tooltip. */
  label: string;
  size?: "sm" | "md";
  active?: boolean;
  disabled?: boolean;
  tooltip?: boolean;
  children: ComponentChildren;
}

/** Square toolbar-style button containing an icon. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = "md", active, tooltip = true, class: className, children, ...props },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      class={cn(
        "inline-flex items-center justify-center rounded-control text-fg-muted hover:bg-hover hover:text-fg active:bg-selected disabled:opacity-40 disabled:pointer-events-none",
        size === "sm" ? "size-6 [&_svg]:size-3.5" : "size-7 [&_svg]:size-4",
        active && "bg-selected text-fg",
        className as string,
      )}
      {...props}
    >
      {children}
    </button>
  );
  return tooltip ? <Tooltip content={label}>{button}</Tooltip> : button;
});
