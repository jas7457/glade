/**
 * Native-looking text inputs. Both forward refs and accept any input/textarea attribute.
 *
 *   <TextField value={v} onInput={(e) => set(e.currentTarget.value)} placeholder="Name" />
 *   <TextArea rows={4} … />
 */
import type { JSX } from "preact";
import { forwardRef } from "preact/compat";
import { cn } from "@/lib/cn";

export const fieldClass =
  "w-full rounded-[5px] bg-control px-2 text-[1rem] text-fg placeholder:text-fg-subtle outline-none " +
  "shadow-[0_0_0_0.5px_var(--pi-separator),inset_0_0.5px_1px_rgb(0_0_0/0.06)] " +
  "focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--pi-accent)_45%,transparent)] focus-visible:outline-none " +
  "disabled:opacity-50";

const invalidClass = "shadow-[0_0_0_1px_var(--pi-danger)]";

export interface TextFieldProps extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: "sm" | "md";
  /** Red outline (validation error). */
  invalid?: boolean;
  /** Use the monospace font (paths, commands). */
  mono?: boolean;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { size = "md", invalid, mono, class: className, type = "text", ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      spellcheck={false}
      autocomplete="off"
      aria-invalid={invalid || undefined}
      class={cn(fieldClass, size === "sm" ? "h-[22px]" : "h-7", mono && "font-mono text-[0.92rem]", invalid && invalidClass, className as string)}
      {...props}
    />
  );
});

export interface TextAreaProps extends JSX.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  mono?: boolean;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { invalid, mono, class: className, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      class={cn(fieldClass, "resize-none py-1.5 leading-snug", mono && "font-mono text-[0.92rem]", invalid && invalidClass, className as string)}
      {...props}
    />
  );
});
