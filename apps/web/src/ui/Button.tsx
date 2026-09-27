import type { ComponentChildren, JSX } from "preact";
import { forwardRef } from "preact/compat";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends Omit<JSX.HTMLAttributes<HTMLButtonElement>, "size"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  children?: ComponentChildren;
}

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg shadow-sm hover:brightness-110 active:brightness-95",
  secondary:
    "bg-control text-fg shadow-[0_0_0_0.5px_var(--pi-separator),0_1px_1px_rgb(0_0_0/0.06)] hover:bg-hover active:bg-selected",
  ghost: "text-fg hover:bg-hover active:bg-selected",
  danger: "bg-danger-fill text-white shadow-sm hover:brightness-110 active:brightness-95",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-6 px-2 text-[0.92rem] gap-1",
  md: "h-7 px-3 text-[1rem] gap-1.5",
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
        "inline-flex items-center justify-center rounded-control font-medium whitespace-nowrap select-none transition-[filter,background-color] duration-100 disabled:opacity-40 disabled:pointer-events-none",
        variants[variant],
        sizes[size],
        className as string,
        className2 as string,
      )}
      {...props}
    />
  );
});
