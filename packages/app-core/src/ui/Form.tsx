/**
 * Grouped form layout in the style of macOS System Settings: rounded inset groups whose rows
 * have a label (+ description) on the left and a control on the right, split by hairlines.
 *
 *   <FormGroup title="Chat">
 *     <FormRow label="Send with" description="…"><SegmentedControl …/></FormRow>
 *   </FormGroup>
 */
import type { ComponentChildren } from "preact";
import { cn } from "@glade/app-core/lib/cn";

export interface FormGroupProps {
  title?: ComponentChildren;
  /** Text under the group. */
  footer?: ComponentChildren;
  /** Controls on the right of the title (e.g. a "Refresh" button). */
  actions?: ComponentChildren;
  children: ComponentChildren;
  class?: string;
}

export function FormGroup({ title, footer, actions, children, class: className }: FormGroupProps) {
  return (
    <section class={cn("mb-6", className)}>
      {(title || actions) && (
        <div class="mb-1.5 flex min-h-6 items-end justify-between gap-2 px-1">
          {title && <h2 class="text-[1rem] font-semibold text-fg-strong">{title}</h2>}
          {actions && <div class="flex items-center gap-1.5">{actions}</div>}
        </div>
      )}
      <div class="divide-y divide-separator rounded-[9px] bg-[color-mix(in_srgb,var(--pi-fg)_3%,transparent)] shadow-[0_0_0_0.5px_var(--pi-separator)]">
        {children}
      </div>
      {footer && <div class="mt-1.5 px-1 text-[0.92rem] text-fg-muted">{footer}</div>}
    </section>
  );
}

export interface FormRowProps {
  label: ComponentChildren;
  description?: ComponentChildren;
  /** id of the control, so clicking the label focuses it. */
  htmlFor?: string;
  children?: ComponentChildren;
  /** Stack the control under the label (wide controls). */
  stacked?: boolean;
  class?: string;
}

export function FormRow({ label, description, htmlFor, children, stacked, class: className }: FormRowProps) {
  return (
    <div class={cn("flex min-h-[40px] gap-x-4 gap-y-2 px-3 py-2", stacked ? "flex-col" : "items-center justify-between", className)}>
      <div class="min-w-0 flex-1">
        <label for={htmlFor} class="block text-fg">
          {label}
        </label>
        {description && <div class="mt-0.5 text-[0.92rem] leading-snug text-fg-muted">{description}</div>}
      </div>
      {children && <div class={cn("flex shrink-0 items-center gap-2", stacked && "w-full")}>{children}</div>}
    </div>
  );
}
