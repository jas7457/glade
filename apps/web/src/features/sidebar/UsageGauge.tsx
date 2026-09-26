/**
 * Subscription usage gauge for the sidebar footer (I-015): a small ring + percent for the most
 * constraining limit; clicking opens a popover with every limit as a labelled bar. Renders
 * nothing when limits are unavailable (`usageLimits` is null), e.g. API-key or non-Anthropic
 * users.
 */
import { useState } from "preact/hooks";
import * as Popover from "@radix-ui/react-popover";
import type { UsageLimit, UsageLimits } from "@pi-ui/protocol";
import { cn } from "@/lib/cn";
import { floatingSurfaceClass } from "@/ui";
import { formatPercent, formatResetsAt, formatUpdatedAgo, primaryLimit, usageLimits } from "@/state/usage";

const toneText: Record<UsageLimit["severity"], string> = {
  normal: "text-fg-muted",
  warning: "text-warning",
  critical: "text-danger",
};
const toneFill: Record<UsageLimit["severity"], string> = {
  normal: "bg-accent",
  warning: "bg-warning",
  critical: "bg-danger",
};

export function UsageGauge() {
  const usage = usageLimits.value;
  const [open, setOpen] = useState(false);
  const primary = usage ? primaryLimit(usage.limits) : null;
  if (!usage || !primary) return null;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`Usage limits: ${primary.label} ${formatPercent(primary.percent)} used${usage.stale ? " (out of date)" : ""}`}
          data-severity={primary.severity}
          class={cn(
            "flex h-[30px] shrink-0 items-center gap-1.5 rounded-[6px] px-2 text-[0.85rem] tabular-nums outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/50 data-[state=open]:bg-selected",
            toneText[primary.severity],
            usage.stale && "opacity-60",
          )}
        >
          <Ring percent={primary.percent} />
          {formatPercent(primary.percent)}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          aria-label="Usage limits"
          class={cn("z-50 w-[272px] rounded-[10px] p-3 text-[1rem] outline-none select-none", floatingSurfaceClass)}
        >
          <UsagePanel usage={usage} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The popover body; exported for tests. */
export function UsagePanel({ usage, now = Date.now() }: { usage: UsageLimits; now?: number }) {
  return (
    <div class="flex flex-col gap-3">
      <div class="text-[0.85rem] font-semibold text-fg-muted">{usage.source} usage</div>
      <ul class="flex flex-col gap-3">
        {usage.limits.map((limit) => (
          <LimitRow key={limit.id} limit={limit} now={now} />
        ))}
      </ul>
      <div class="border-t border-separator pt-2 text-[0.85rem] text-fg-subtle">
        {formatUpdatedAgo(usage.fetchedAt, now)}
        {usage.stale && " · may be out of date"}
      </div>
    </div>
  );
}

function LimitRow({ limit, now }: { limit: UsageLimit; now: number }) {
  const resets = formatResetsAt(limit.resetsAt, now);
  const pct = Math.min(100, Math.max(0, limit.percent));
  return (
    <li data-limit-id={limit.id} class="flex flex-col gap-1">
      <div class="flex items-baseline justify-between gap-2">
        <span class="min-w-0 truncate font-medium">{limit.label}</span>
        <span class={cn("shrink-0 text-[0.85rem] tabular-nums", limit.severity === "normal" ? "text-fg-muted" : toneText[limit.severity])}>
          {formatPercent(limit.percent)} used
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={limit.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        class="h-1.5 overflow-hidden rounded-full bg-fg/10"
      >
        <div class={cn("h-full rounded-full", toneFill[limit.severity])} style={{ width: `${pct}%` }} />
      </div>
      {resets && <div class="text-[0.85rem] text-fg-subtle">{resets}</div>}
    </li>
  );
}

/** 14px progress ring in the current text colour. */
function Ring({ percent }: { percent: number }) {
  const r = 5.5;
  const c = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, percent));
  return (
    <svg viewBox="0 0 14 14" class="size-3.5 -rotate-90" aria-hidden="true">
      <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="2" />
      {pct > 0 && (
        <circle
          cx="7"
          cy="7"
          r={r}
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-dasharray={`${(pct / 100) * c} ${c}`}
        />
      )}
    </svg>
  );
}
