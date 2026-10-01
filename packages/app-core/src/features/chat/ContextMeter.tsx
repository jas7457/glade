/**
 * Context meter (I-014, I-057): a small ring in the composer toolbar showing how full the model's
 * context window is. Amber above 80%, red above 95%; a dashed ring when the size is unknown (right
 * after compaction, until the next reply). Hovering (or clicking, which pins it) opens a popover
 * with a context bar, the session cost and every agent's subscription limits (`usageLimits`,
 * I-191), the chat's own agent first. The ring stays context-only.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import * as Popover from "@radix-ui/react-popover";
import type { ModelRef, SessionState } from "@glade/protocol";
import { cn } from "@glade/app-core/lib/cn";
import { usageForChat, usageLimitsOf } from "@glade/app-core/state/usage";
import { floatingSurfaceClass } from "@glade/app-core/ui";
import { describeUsage, meterLevel, usagePercent } from "./context-meter";
import { UsageDetails } from "./usage/UsageDetails";

const SIZE = 16;
const STROKE = 2;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Hover delays (ms): open after resting on the ring, close after leaving ring + popover. */
const OPEN_DELAY = 250;
const CLOSE_DELAY = 200;

const levelClass = { normal: "text-fg-muted", warning: "text-warning", critical: "text-danger" } as const;

export interface ContextMeterProps {
  usage: SessionState["contextUsage"];
  cost?: number;
  compacting?: boolean;
  /** The chat's current model: its per-model limit is tagged, its agent's limits go first. */
  model?: ModelRef | null;
  /** The chat's agent (harness id): its limits go first. */
  harnessId?: string | null;
  /** The chat's environment: the limits shown are that Mac's accounts (default: this device's). */
  envId?: string | null;
  /** The popover opened/closed (the touch composer stays expanded while it's open). */
  onOpenChange?: (open: boolean) => void;
}

export function ContextMeter({ usage, cost, compacting, model, harnessId, envId, onOpenChange: notifyOpen }: ContextMeterProps) {
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    notifyOpen?.(next);
  };
  const pinned = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clear = () => clearTimeout(timer.current);
  const notifyRef = useRef(notifyOpen);
  notifyRef.current = notifyOpen;
  useEffect(
    () => () => {
      clear();
      notifyRef.current?.(false);
    },
    [],
  );

  if (!usage) return null;
  const percent = usagePercent(usage);
  const known = percent !== null && usage.tokens !== null;
  const level = meterLevel(percent);
  const filled = known ? Math.min(100, percent) / 100 : 0;
  const summary = describeUsage(usage);

  const hoverOpen = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clear();
    if (!open) timer.current = setTimeout(() => setOpen(true), OPEN_DELAY);
  };
  const hoverClose = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clear();
    if (!pinned.current) timer.current = setTimeout(() => setOpen(false), CLOSE_DELAY);
  };
  const onOpenChange = (next: boolean) => {
    clear();
    pinned.current = next; // opened by click/keyboard → stays until dismissed
    setOpen(next);
  };

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`Context usage: ${summary}`}
          data-level={known ? level : "unknown"}
          class={cn(
            "inline-flex size-6 items-center justify-center rounded-control outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/50 data-[state=open]:bg-hover",
            levelClass[level],
          )}
          onPointerEnter={hoverOpen}
          onPointerLeave={hoverClose}
          onClick={(e) => {
            // Opened by hover: a click pins it instead of toggling it closed.
            if (open && !pinned.current) {
              e.preventDefault();
              clear();
              pinned.current = true;
            }
          }}
        >
          <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true" class={cn(compacting && "animate-pulse")}>
            <circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke="currentColor"
              stroke-width={STROKE}
              opacity={known ? 0.25 : 0.6}
              stroke-dasharray={known ? undefined : "2 2.4"}
            />
            {known && filled > 0 && (
              <circle
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                stroke="currentColor"
                stroke-width={STROKE}
                stroke-linecap="round"
                stroke-dasharray={`${Math.max(filled * CIRCUMFERENCE, 1.5)} ${CIRCUMFERENCE}`}
                transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
              />
            )}
          </svg>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={{ top: 8 + (open ? safeAreaTop() : 0), right: 8, bottom: 8, left: 8 }}
          aria-label="Usage"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onPointerEnter={clear}
          onPointerLeave={hoverClose}
          class={cn("z-50 max-h-[var(--radix-popover-content-available-height)] w-[280px] overflow-y-auto rounded-[10px] p-3.5 text-[1rem] leading-snug outline-none select-none", floatingSurfaceClass)}
        >
          <UsageDetails
            usage={usage}
            cost={cost}
            compacting={compacting}
            limits={usageForChat(usageLimitsOf(envId), harnessId, model)}
            model={model}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The top safe-area inset in px (the iPhone's status bar; 0 elsewhere), so the popover stays below it. */
function safeAreaTop(): number {
  if (typeof document === "undefined" || !document.body) return 0;
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top)";
  document.body.appendChild(probe);
  const top = Number.parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return top;
}
