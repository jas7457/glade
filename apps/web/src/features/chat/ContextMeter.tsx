/**
 * Context meter (I-014, I-057): a small ring in the composer toolbar showing how full the model's
 * context window is. Amber above 80%, red above 95%; a dashed ring when the size is unknown (right
 * after compaction, until the next reply). Hovering (or clicking, which pins it) opens a popover
 * with a context bar, the session cost and, when the chat's model belongs to the limits'
 * provider, the subscription limits (`usageLimits`). The ring stays context-only.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import * as Popover from "@radix-ui/react-popover";
import type { ModelRef, SessionState } from "@glade/protocol";
import { cn } from "@/lib/cn";
import { limitsForModel, usageLimits } from "@/state/usage";
import { floatingSurfaceClass } from "@/ui";
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
  /** The chat's current model; subscription limits show only for their provider's models. */
  model?: ModelRef | null;
}

export function ContextMeter({ usage, cost, compacting, model }: ContextMeterProps) {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clear = () => clearTimeout(timer.current);
  useEffect(() => clear, []);

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
          collisionPadding={8}
          aria-label="Usage"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onPointerEnter={clear}
          onPointerLeave={hoverClose}
          class={cn("z-50 w-[280px] rounded-[10px] p-3.5 text-[1rem] leading-snug outline-none select-none", floatingSurfaceClass)}
        >
          <UsageDetails
            usage={usage}
            cost={cost}
            compacting={compacting}
            limits={limitsForModel(usageLimits.value, model)}
            model={model}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
