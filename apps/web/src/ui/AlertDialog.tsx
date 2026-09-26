/**
 * macOS-style alert + a promise-based `confirm()` helper.
 *
 *   if (await confirm({ title: "Delete chat?", message: "This can't be undone.",
 *                        confirmLabel: "Delete", destructive: true })) { … }
 *
 * Requires <ConfirmHost /> to be mounted once (the app shell does this).
 */
import type { ComponentChildren } from "preact";
import { signal } from "@preact/signals";
import * as RadixAlert from "@radix-ui/react-alert-dialog";
import { cn } from "@/lib/cn";
import { Button } from "./Button";
import { overlayClass } from "./Dialog";

export interface ConfirmOptions {
  title: ComponentChildren;
  message?: ComponentChildren;
  /** Default "OK". */
  confirmLabel?: string;
  /** Default "Cancel". Pass `null` for an informational alert with a single button. */
  cancelLabel?: string | null;
  /** Red confirm button; Cancel gets the initial focus. */
  destructive?: boolean;
}

interface Pending extends ConfirmOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

const queue = signal<Pending[]>([]);
let nextId = 1;

/** Ask the user to confirm something. Resolves `true` if they pressed the confirm button. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    queue.value = [...queue.value, { ...options, id: nextId++, resolve }];
  });
}

function settle(id: number, ok: boolean) {
  const item = queue.value.find((p) => p.id === id);
  queue.value = queue.value.filter((p) => p.id !== id);
  item?.resolve(ok);
}

export interface AlertDialogProps extends ConfirmOptions {
  open: boolean;
  onResult: (ok: boolean) => void;
}

/** Controlled alert. Most code should use `confirm()` instead. */
export function AlertDialog({ open, onResult, title, message, confirmLabel = "OK", cancelLabel = "Cancel", destructive }: AlertDialogProps) {
  return (
    <RadixAlert.Root open={open} onOpenChange={(o) => !o && onResult(false)}>
      <RadixAlert.Portal>
        <RadixAlert.Overlay class={overlayClass} />
        <RadixAlert.Content
          onOpenAutoFocus={(e) => {
            // The default button gets focus unless the action is destructive.
            if (destructive || cancelLabel === null) return;
            e.preventDefault();
            (e.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-default]")?.focus();
          }}
          class={cn(
            "fixed top-1/2 left-1/2 z-50 w-[272px] -translate-x-1/2 -translate-y-1/2 rounded-[12px] bg-surface-raised/95 p-4 text-center text-fg shadow-popover outline-none backdrop-blur-xl",
            "animate-[pi-pop-in_150ms_ease-out] dark:ring-1 dark:ring-white/10",
          )}
        >
          <RadixAlert.Title class="text-[1rem] font-semibold text-fg-strong">{title}</RadixAlert.Title>
          <RadixAlert.Description class={cn("mt-1.5 text-[0.92rem] text-fg-muted", !message && "sr-only")}>
            {message ?? title}
          </RadixAlert.Description>
          <div class="mt-4 flex gap-2">
            {cancelLabel !== null && (
              <RadixAlert.Cancel asChild>
                <Button class="flex-1">{cancelLabel}</Button>
              </RadixAlert.Cancel>
            )}
            <RadixAlert.Action asChild>
              <Button data-default variant={destructive ? "danger" : "primary"} class="flex-1" onClick={() => onResult(true)}>
                {confirmLabel}
              </Button>
            </RadixAlert.Action>
          </div>
        </RadixAlert.Content>
      </RadixAlert.Portal>
    </RadixAlert.Root>
  );
}

/** Renders the first pending `confirm()` request. Mount once at the app root. */
export function ConfirmHost() {
  const current = queue.value[0];
  if (!current) return null;
  const { id, resolve: _resolve, ...options } = current;
  return <AlertDialog key={id} open {...options} onResult={(ok) => settle(id, ok)} />;
}
