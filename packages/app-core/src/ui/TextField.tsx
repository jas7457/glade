/**
 * Native-looking text inputs. Both forward refs and accept any input/textarea attribute.
 *
 *   <TextField value={v} onInput={(e) => set(e.currentTarget.value)} placeholder="Name" />
 *   <TextField leadingIcon={<Folder />} … />   // icon inside the field, text starts after it
 *   <TextArea rows={4} … />
 */
import type { ComponentChildren, JSX } from "preact";
import { forwardRef } from "preact/compat";
import { cn } from "@glade/app-core/lib/cn";

export const fieldClass =
  "w-full rounded-[5px] bg-control pr-2 pl-2 text-[1rem] text-fg placeholder:text-fg-subtle outline-none " +
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
  /**
   * Icon drawn inside the field on the left (14px, subtle). The text/caret starts after it with
   * a gap; clicks on the icon fall through to the input.
   */
  leadingIcon?: ComponentChildren;
}

/** Icon at 10px from the edge, 14px wide; text starts at 32px (an 8px gap after the icon). */
const leadingIconClass =
  "pointer-events-none absolute top-1/2 left-2.5 flex size-3.5 -translate-y-1/2 items-center justify-center text-fg-subtle [&_svg]:size-3.5";
const withLeadingIconClass = "pl-8";

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { size = "md", invalid, mono, leadingIcon, class: className, type = "text", ...props },
  ref,
) {
  const input = (
    <input
      ref={ref}
      type={type}
      spellcheck={false}
      autocomplete="off"
      aria-invalid={invalid || undefined}
      class={cn(
        fieldClass,
        size === "sm" ? "h-[22px]" : "h-7",
        mono && "font-mono text-[0.92rem]",
        invalid && invalidClass,
        leadingIcon != null && withLeadingIconClass,
        className as string,
      )}
      {...props}
    />
  );
  if (leadingIcon == null) return input;
  return (
    <div class="relative w-full min-w-0">
      <span aria-hidden data-slot="leading-icon" class={leadingIconClass}>
        {leadingIcon}
      </span>
      {input}
    </div>
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
