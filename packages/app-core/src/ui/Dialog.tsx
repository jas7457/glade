/**
 * Modal panel (e.g. Create project) and the parts it shares with the confirm alert
 * (ui/AlertDialog.tsx), so every modal has the same surface, spacing, typography and buttons:
 *
 * - {@link dialogClass}: overlay, panel, header, title, description, body and footer classes.
 * - {@link DialogIcon}: an optional small icon on the title's first line.
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
import { cn } from "@glade/app-core/lib/cn";

/**
 * Shared modal classes. Keep Dialog and AlertDialog on these so they always match.
 *
 * One grid (I-114), macOS alert/sheet style: 20px padding on every side; the title, message,
 * body and buttons all share that one column (left edges at 20px, right edges at width − 20px);
 * 4px from title to message, 16px between blocks, 8px between buttons. Spacing is in px on
 * purpose, so the grid stays put when the text size setting changes.
 */
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
  /** Title (with an optional small icon on its first line) and the message, one column. */
  header: "flex flex-col gap-[4px] px-[20px] pt-[20px]",
  /** Icon + title row; the icon is centred on the title's first line. */
  titleRow: "flex min-w-0 items-start gap-[8px]",
  title: "min-w-0 flex-1 text-[1.08rem] leading-[1.35] font-semibold text-fg-strong [overflow-wrap:anywhere]",
  description: "leading-[1.45] text-fg-muted [overflow-wrap:anywhere]",
  /** Scrolls; the 4px bottom padding (pulled back by the margin) keeps field rings from being clipped. */
  body: "min-h-0 flex-1 overflow-y-auto px-[20px] pt-[16px] pb-[4px] -mb-[4px]",
  /** Right-aligned, natural-width buttons on the column's right edge; the default button goes last. */
  footer: "flex shrink-0 items-center justify-end gap-[8px] px-[20px] pt-[20px] pb-[20px] [&>button]:min-w-[72px]",
} as const;

export type DialogTone = "danger" | "accent";

/**
 * Optional small glyph before the title, e.g. `<DialogIcon tone="danger"><Trash2 /></DialogIcon>`.
 * No tinted circle (I-114): a 16px icon, vertically centred on the title's first line.
 */
export function DialogIcon({ tone = "accent", children }: { tone?: DialogTone; children: ComponentChildren }) {
  return (
    <span
      aria-hidden
      class={cn(
        "flex h-[1.35em] shrink-0 items-center text-[1.08rem] [&>svg]:size-[16px]",
        tone === "danger" ? "text-danger" : "text-accent",
      )}
    >
      {children}
    </span>
  );
}

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ComponentChildren;
  /** Short explanatory text under the title. */
  description?: ComponentChildren;
  /** Optional small icon on the title's first line. */
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

/**
 * A pointer/focus event "outside" the panel that actually landed in a menu, popover or tooltip
 * opened from inside it (I-139). Radix tells those apart by bubbling through the React tree,
 * but Preact portals only bubble through the DOM, so a pick in a Select inside the dialog
 * (its menu is portaled to <body>) looked like a click outside and closed the dialog.
 * Under a modal dialog nothing else outside the panel takes pointer events, so any Radix
 * floating layer on screen was opened from within it.
 */
function isInNestedLayer(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("[data-radix-popper-content-wrapper]");
}

const keepOpenForNestedLayers = (e: Event) => {
  if (isInNestedLayer(e.target)) e.preventDefault();
};

export function Dialog({ open, onOpenChange, title, description, icon, iconTone, children, footer, width = 440, class: className, onOpenAutoFocus }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay class={dialogClass.overlay} />
        <RadixDialog.Content
          onOpenAutoFocus={onOpenAutoFocus}
          onInteractOutside={keepOpenForNestedLayers}
          style={{ width: `min(${width}px, calc(100vw - 32px))` }}
          class={cn(dialogClass.panel, className)}
        >
          <div class={dialogClass.header}>
            <div class={dialogClass.titleRow}>
              {icon && <DialogIcon tone={iconTone}>{icon}</DialogIcon>}
              <RadixDialog.Title class={dialogClass.title}>{title}</RadixDialog.Title>
            </div>
            {description ? (
              <RadixDialog.Description class={dialogClass.description}>{description}</RadixDialog.Description>
            ) : (
              <RadixDialog.Description class="sr-only">{title}</RadixDialog.Description>
            )}
          </div>
          {children && <div class={dialogClass.body}>{children}</div>}
          {footer ? <div class={dialogClass.footer}>{footer}</div> : <div class="h-[20px] shrink-0" />}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DialogClose = RadixDialog.Close;
