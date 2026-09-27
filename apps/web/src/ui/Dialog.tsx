/**
 * Modal panel (e.g. Create project) and the parts it shares with the confirm alert
 * (ui/AlertDialog.tsx), so every modal has the same surface, spacing, typography and buttons:
 *
 * - {@link dialogClass}: overlay, panel, header, title, description, body and footer classes.
 * - {@link DialogIcon}: the optional leading icon in a tinted circle (e.g. a red trash can).
 *
 * The panel uses the floating-surface look (ui/floating.ts: popover background, hairline border)
 * with a deeper `dialog` shadow, sits over a dimmed, lightly blurred backdrop, is anchored near
 * the top (so it doesn't jump when its content grows) and scales + fades in.
 *
 *   <Dialog open={open} onOpenChange={setOpen} title="Create project"
 *           footer={<><Button onClick={close}>Cancel</Button><Button variant="primary">Create</Button></>}>
 *     …body…
 *   </Dialog>
 */
import type { ComponentChildren } from "preact";
import * as RadixDialog from "@radix-ui/react-dialog";
import { cn } from "@/lib/cn";

/** Shared modal classes. Keep Dialog and AlertDialog on these so they always match. */
export const dialogClass = {
  overlay: "fixed inset-0 z-40 bg-backdrop backdrop-blur-[2px] animate-[pi-fade-in_140ms_ease-out]",
  /*
   * Centred horizontally with the `translate` utility; the keyframe only animates `transform`
   * (scale) and opacity, so the two never add up (see the note above the keyframes, I-018).
   */
  panel: cn(
    "fixed top-[max(48px,16vh)] left-1/2 z-50 flex max-h-[calc(100vh-96px)] -translate-x-1/2 flex-col",
    "rounded-[12px] bg-popover text-fg ring-1 ring-popover-border shadow-dialog outline-none",
    "origin-top animate-[pi-dialog-in_160ms_cubic-bezier(0.2,0.9,0.3,1)]",
  ),
  /** Icon (optional) + text column. */
  header: "flex items-start gap-3 px-5 pt-5",
  title: "text-[1.08rem] leading-snug font-semibold text-fg-strong [overflow-wrap:anywhere]",
  description: "mt-1 leading-relaxed text-fg-muted [overflow-wrap:anywhere]",
  body: "min-h-0 flex-1 overflow-y-auto px-5 pt-4",
  /** Right-aligned, natural-width buttons; the default button goes last. */
  footer: "flex shrink-0 items-center justify-end gap-2 p-5 [&>button]:min-w-[76px]",
} as const;

export type DialogTone = "danger" | "accent";

/** Leading icon in a tinted circle, e.g. `<DialogIcon tone="danger"><Trash2 /></DialogIcon>`. */
export function DialogIcon({ tone = "accent", children }: { tone?: DialogTone; children: ComponentChildren }) {
  return (
    <div
      aria-hidden
      class={cn(
        "grid size-9 shrink-0 place-items-center rounded-full [&>svg]:size-[18px]",
        tone === "danger" ? "bg-danger/12 text-danger" : "bg-accent/12 text-accent",
      )}
    >
      {children}
    </div>
  );
}

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ComponentChildren;
  /** Short explanatory text under the title. */
  description?: ComponentChildren;
  /** Optional leading icon, shown in a tinted circle next to the title. */
  icon?: ComponentChildren;
  iconTone?: DialogTone;
  children?: ComponentChildren;
  /** Buttons, right aligned. Put the default (primary) button last. */
  footer?: ComponentChildren;
  /** Panel width in px (default 440). */
  width?: number;
  class?: string;
  /** Called when the dialog opens; call `e.preventDefault()` to keep focus where it is. */
  onOpenAutoFocus?: (e: Event) => void;
}

export function Dialog({ open, onOpenChange, title, description, icon, iconTone, children, footer, width = 440, class: className, onOpenAutoFocus }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay class={dialogClass.overlay} />
        <RadixDialog.Content
          onOpenAutoFocus={onOpenAutoFocus}
          style={{ width: `min(${width}px, calc(100vw - 32px))` }}
          class={cn(dialogClass.panel, className)}
        >
          <div class={dialogClass.header}>
            {icon && <DialogIcon tone={iconTone}>{icon}</DialogIcon>}
            <div class="min-w-0 flex-1">
              <RadixDialog.Title class={dialogClass.title}>{title}</RadixDialog.Title>
              {description ? (
                <RadixDialog.Description class={dialogClass.description}>{description}</RadixDialog.Description>
              ) : (
                <RadixDialog.Description class="sr-only">{title}</RadixDialog.Description>
              )}
            </div>
          </div>
          {children && <div class={dialogClass.body}>{children}</div>}
          {footer ? <div class={dialogClass.footer}>{footer}</div> : <div class="h-5 shrink-0" />}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DialogClose = RadixDialog.Close;
