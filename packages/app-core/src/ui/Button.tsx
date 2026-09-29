import type { ComponentChildren, JSX } from "preact";
import { forwardRef } from "preact/compat";
import { cn } from "@glade/app-core/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends Omit<JSX.HTMLAttributes<HTMLButtonElement>, "size"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  children?: ComponentChildren;
}

/*
 * macOS push buttons (I-114): a plain bezel (hairline + soft shadow) or an accent fill with a
 * faint top highlight, regular label weight, no hover effect beyond a slight tone change.
 * `danger` is the filled accent button in red (I-128): same highlight and shadow as `primary`, so
 * a destructive action stands out from Cancel (red text on a grey bezel read as washed out).
 */
const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg shadow-bezel-filled hover:brightness-105 active:brightness-90",
  secondary: "bg-bezel text-fg shadow-bezel hover:brightness-[0.98] active:brightness-[0.94] dark:hover:brightness-110 dark:active:brightness-125",
  ghost: "text-fg hover:bg-hover active:bg-selected",
  danger: "bg-danger-fill text-white shadow-bezel-filled hover:brightness-105 active:brightness-90",
};

/** md is the regular macOS push button (22px at the 13px base); sm the small one. */
const sizes: Record<ButtonSize, string> = {
  sm: "h-6 px-2 text-[0.92rem] gap-1",
  md: "h-[1.7rem] px-[0.85rem] text-[1rem] gap-1.5",
};

/** macOS-style push button. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", class: className, className: className2, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      class={cn(
        "inline-flex items-center justify-center rounded-control whitespace-nowrap select-none transition-[filter,background-color] duration-100 disabled:opacity-40 disabled:pointer-events-none",
        variants[variant],
        sizes[size],
        className as string,
        className2 as string,
      )}
      {...props}
    />
  );
});
