/**
 * Renders `state/toasts` as a bottom-right stack of notification-style banners.
 * Mount once at the app root.
 */
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-preact";
import { dismissToast, toasts, type Toast } from "@glade/app-core/state/toasts";
import { cn } from "@glade/app-core/lib/cn";
import { Button } from "./Button";

const icons: Record<Toast["level"], { Icon: typeof Info; class: string }> = {
  info: { Icon: Info, class: "text-accent" },
  success: { Icon: CheckCircle2, class: "text-success" },
  warning: { Icon: AlertTriangle, class: "text-warning" },
  error: { Icon: XCircle, class: "text-danger" },
};

export function Toaster() {
  const list = toasts.value;
  return (
    <div
      aria-live="polite"
      class="pointer-events-none fixed right-3 bottom-3 z-[60] flex w-[340px] max-w-[calc(100vw-24px)] flex-col items-stretch gap-2"
    >
      {list.map((t) => {
        const { Icon, class: iconClass } = icons[t.level];
        return (
          <div
            key={t.id}
            role={t.level === "error" ? "alert" : "status"}
            class={cn(
              "group pointer-events-auto relative flex items-start gap-2.5 rounded-[12px] bg-surface-raised/90 px-3 py-2.5 shadow-popover backdrop-blur-xl",
              "animate-[pi-toast-in_200ms_cubic-bezier(0.2,0.9,0.3,1)] dark:ring-1 dark:ring-white/10",
            )}
          >
            <Icon size={16} class={cn("mt-px shrink-0", iconClass)} />
            <div class="selectable min-w-0 flex-1 text-[0.92rem] leading-snug break-words text-fg">
              {t.title && <div class="font-semibold text-fg-strong">{t.title}</div>}
              <div class={cn(t.title && "text-fg-muted")}>{t.message}</div>
            </div>
            {t.action && (
              <Button
                size="sm"
                class="shrink-0 self-center"
                onClick={() => {
                  dismissToast(t.id);
                  t.action!.onClick();
                }}
              >
                {t.action.label}
              </Button>
            )}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismissToast(t.id)}
              class="absolute -top-1.5 -left-1.5 flex size-[18px] items-center justify-center rounded-full bg-surface-raised text-fg-muted opacity-0 shadow-popover group-hover:opacity-100 hover:text-fg"
            >
              <X size={10} strokeWidth={3} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
