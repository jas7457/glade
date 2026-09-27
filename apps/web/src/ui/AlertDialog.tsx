/**
 * Confirm alert + a promise-based `confirm()` helper. Same surface, spacing and buttons as
 * ui/Dialog.tsx (shared {@link dialogClass}): a short heading, the item's name in the body,
 * an optional leading icon (destructive confirms get a red trash can) and right-aligned buttons.
 *
 *   if (await confirm({ title: "Delete chat?", subject: chat.title,
 *                        message: "will be permanently deleted. This can't be undone.",
 *                        confirmLabel: "Delete", destructive: true })) { … }
 *
 * Requires <ConfirmHost /> to be mounted once (the app shell does this).
 */
import type { ComponentChildren } from "preact";
import { signal } from "@preact/signals";
import * as RadixAlert from "@radix-ui/react-alert-dialog";
import { Trash2 } from "lucide-preact";
import { cn } from "@/lib/cn";
import { Button } from "./Button";
import { DialogIcon, dialogClass } from "./Dialog";

export interface ConfirmOptions {
  /** Short heading, e.g. "Delete chat?". Keep item names out of it (use `subject`). */
  title: ComponentChildren;
  /**
   * The item the action applies to (a chat title, a project name). Shown quoted in the strong
   * text colour at the start of the message ("“Name” will be deleted…"); very long names are
   * shortened with an ellipsis.
   */
  subject?: string;
  message?: ComponentChildren;
  /** Leading icon in a tinted circle. Destructive confirms default to a trash can; `null` hides it. */
  icon?: ComponentChildren | null;
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

/** Longest subject shown in full; longer ones are cut with "…" (the full name is in the tooltip). */
const SUBJECT_MAX = 80;

export function shortenSubject(subject: string, max = SUBJECT_MAX): string {
  const s = subject.trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

export interface AlertDialogProps extends ConfirmOptions {
  open: boolean;
  onResult: (ok: boolean) => void;
}

/** Controlled alert. Most code should use `confirm()` instead. */
export function AlertDialog({ open, onResult, title, subject, message, icon, confirmLabel = "OK", cancelLabel = "Cancel", destructive }: AlertDialogProps) {
  const shownIcon = icon === undefined ? (destructive ? <Trash2 /> : null) : icon;
  const hasBody = !!subject || !!message;
  return (
    <RadixAlert.Root open={open} onOpenChange={(o) => !o && onResult(false)}>
      <RadixAlert.Portal>
        <RadixAlert.Overlay class={dialogClass.overlay} />
        <RadixAlert.Content
          onOpenAutoFocus={(e) => {
            // The default button gets focus unless the action is destructive.
            if (destructive || cancelLabel === null) return;
            e.preventDefault();
            (e.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-default]")?.focus();
          }}
          style={{ width: "min(400px, calc(100vw - 32px))" }}
          class={dialogClass.panel}
        >
          <div class={dialogClass.header}>
            {shownIcon && <DialogIcon tone={destructive ? "danger" : "accent"}>{shownIcon}</DialogIcon>}
            <div class={cn("min-w-0 flex-1", shownIcon && "pt-[7px]")}>
              <RadixAlert.Title class={dialogClass.title}>{title}</RadixAlert.Title>
              <RadixAlert.Description class={cn(dialogClass.description, "mt-1.5", !hasBody && "sr-only")}>
                {hasBody ? (
                  <>
                    {subject && (
                      <span class="font-medium text-fg-strong" title={subject.length > SUBJECT_MAX ? subject : undefined}>
                        “{shortenSubject(subject)}”
                      </span>
                    )}
                    {subject && message ? " " : null}
                    {message}
                  </>
                ) : (
                  title
                )}
              </RadixAlert.Description>
            </div>
          </div>
          <div class={dialogClass.footer}>
            {cancelLabel !== null && (
              <RadixAlert.Cancel asChild>
                <Button>{cancelLabel}</Button>
              </RadixAlert.Cancel>
            )}
            <RadixAlert.Action asChild>
              <Button data-default variant={destructive ? "danger" : "primary"} onClick={() => onResult(true)}>
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
