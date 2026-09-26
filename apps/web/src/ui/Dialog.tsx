/**
 * Modal panel styled like a macOS sheet: dims the window, slides down from the top, with a
 * title, body and a right-aligned button footer.
 *
 *   <Dialog open={open} onOpenChange={setOpen} title="Add Project"
 *           footer={<><Button onClick={close}>Cancel</Button><Button variant="primary">Add</Button></>}>
 *     …body…
 *   </Dialog>
 */
import type { ComponentChildren } from "preact";
import * as RadixDialog from "@radix-ui/react-dialog";
import { cn } from "@/lib/cn";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ComponentChildren;
  /** Short explanatory text under the title. */
  description?: ComponentChildren;
  children?: ComponentChildren;
  /** Buttons, right aligned. Put the default (primary) button last. */
  footer?: ComponentChildren;
  /** Panel width in px (default 460). */
  width?: number;
  class?: string;
  /** Called when the dialog opens; call `e.preventDefault()` to keep focus where it is. */
  onOpenAutoFocus?: (e: Event) => void;
}

export const overlayClass = "fixed inset-0 z-40 bg-black/20 animate-[pi-fade-in_120ms_ease-out] dark:bg-black/40";

export function Dialog({ open, onOpenChange, title, description, children, footer, width = 460, class: className, onOpenAutoFocus }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay class={overlayClass} />
        <RadixDialog.Content
          onOpenAutoFocus={onOpenAutoFocus}
          aria-describedby={description ? undefined : undefined}
          style={{ width: `min(${width}px, calc(100vw - 32px))` }}
          class={cn(
            "fixed top-[max(40px,8vh)] left-1/2 z-50 flex max-h-[calc(100vh-80px)] -translate-x-1/2 flex-col rounded-panel bg-surface-raised text-fg shadow-popover outline-none",
            "animate-[pi-sheet-in_180ms_cubic-bezier(0.2,0.9,0.3,1)] dark:ring-1 dark:ring-white/10",
            className,
          )}
        >
          <div class="px-5 pt-4 pb-1">
            <RadixDialog.Title class="text-[1.08rem] font-semibold text-fg-strong">{title}</RadixDialog.Title>
            {description ? (
              <RadixDialog.Description class="mt-1 text-fg-muted">{description}</RadixDialog.Description>
            ) : (
              <RadixDialog.Description class="sr-only">{title}</RadixDialog.Description>
            )}
          </div>
          {children && <div class="min-h-0 flex-1 overflow-y-auto px-5 py-3">{children}</div>}
          {footer && <div class="flex items-center justify-end gap-2 px-5 pt-1 pb-4">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DialogClose = RadixDialog.Close;
