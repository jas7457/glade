/**
 * A floating, persistent notice card (I-197): looks like a toast (`Toaster.tsx`) but stays until
 * its owner removes it and can hold several buttons and live text, e.g. "Glade restarts when
 * 2 chats finish · Restart Now · Cancel". Place it with `class` (it is `fixed` by default at the
 * top right, below the title bar, so it doesn't collide with the toasts at the bottom right).
 */
import type { ComponentChildren } from "preact";
import { cn } from "@glade/app-core/lib/cn";
import { TITLEBAR_HEIGHT } from "./Titlebar";

export interface NoticeProps {
  /** Leading icon (e.g. a Spinner or a lucide icon). */
  icon?: ComponentChildren;
  title?: ComponentChildren;
  message?: ComponentChildren;
  /** Buttons, right-aligned under the text. */
  actions?: ComponentChildren;
  class?: string;
  "data-testid"?: string;
}

export function Notice({ icon, title, message, actions, class: className, "data-testid": testId }: NoticeProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={testId}
      style={{ top: `${TITLEBAR_HEIGHT + 8}px` }}
      class={cn(
        "fixed right-3 z-[60] flex w-[340px] max-w-[calc(100vw-24px)] flex-col gap-2 rounded-[12px] bg-surface-raised/90 px-3 py-2.5 shadow-popover backdrop-blur-xl",
        "animate-[pi-toast-in_200ms_cubic-bezier(0.2,0.9,0.3,1)] dark:ring-1 dark:ring-white/10",
        className,
      )}
    >
      <div class="flex items-start gap-2.5">
        {icon && <span class="mt-px flex shrink-0">{icon}</span>}
        <div class="min-w-0 flex-1 text-[0.92rem] leading-snug break-words text-fg">
          {title && <div class="font-semibold text-fg-strong">{title}</div>}
          {message && <div class={cn(title && "text-fg-muted")}>{message}</div>}
        </div>
      </div>
      {actions && <div class="flex justify-end gap-2">{actions}</div>}
    </div>
  );
}
