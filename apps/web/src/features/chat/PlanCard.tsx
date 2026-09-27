/**
 * An agent's plan as a small checklist card in the transcript (a `plan` notice, I-119): pending ○,
 * in progress ◐, completed ✓. The harness re-sends the whole plan under the same message id, so
 * the card updates in place. Long plans show {@link PLAN_PREVIEW_ITEMS} steps around the current
 * one until "Show all".
 */
import { memo } from "preact/compat";
import { useState } from "preact/hooks";
import { Check, Circle, CircleDashed, ListChecks } from "lucide-preact";
import type { PlanEntry } from "@glade/protocol";
import { cn } from "@/lib/cn";

export const PLAN_PREVIEW_ITEMS = 5;

/**
 * The steps shown while collapsed: a window of `max` that starts one step before the first
 * unfinished one (so the step being worked on is visible), clamped to the list.
 */
export function planPreview(entries: readonly PlanEntry[], max = PLAN_PREVIEW_ITEMS): { start: number; items: PlanEntry[] } {
  if (entries.length <= max) return { start: 0, items: [...entries] };
  const current = entries.findIndex((e) => e.status !== "completed");
  const start = Math.max(0, Math.min((current === -1 ? entries.length : current) - 1, entries.length - max));
  return { start, items: entries.slice(start, start + max) };
}

const statusLabel = { pending: "Pending", in_progress: "In progress", completed: "Done" } as const;

function StatusIcon({ status }: { status: PlanEntry["status"] }) {
  if (status === "completed") return <Check size={12} strokeWidth={2.5} class="text-success" />;
  if (status === "in_progress") return <CircleDashed size={12} strokeWidth={2.25} class="text-accent" />;
  return <Circle size={12} class="text-fg-subtle" />;
}

export const PlanCard = memo(function PlanCard({ entries }: { entries: PlanEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const done = entries.filter((e) => e.status === "completed").length;
  const shown = expanded ? { start: 0, items: entries } : planPreview(entries);
  const hidden = entries.length - shown.items.length;
  return (
    <div data-role="plan" class="my-3 max-w-[36rem] rounded-[10px] border-[0.5px] border-separator bg-surface px-3 py-2 text-[0.92rem]">
      <div class="mb-1 flex items-center gap-1.5 text-fg-muted">
        <ListChecks size={13} class="shrink-0" />
        <span class="font-medium text-fg">Plan</span>
        <span class="text-fg-subtle tabular-nums">
          {done} of {entries.length} done
        </span>
      </div>
      <ul class="flex flex-col gap-0.5">
        {shown.items.map((entry, i) => (
          <li key={shown.start + i} data-status={entry.status} class="flex items-start gap-2">
            <span class="mt-[3px] flex w-3 shrink-0 justify-center" role="img" aria-label={statusLabel[entry.status]}>
              <StatusIcon status={entry.status} />
            </span>
            <span
              class={cn(
                "selectable min-w-0 flex-1 break-words",
                entry.status === "completed" ? "text-fg-subtle" : entry.status === "in_progress" ? "text-fg" : "text-fg-muted",
              )}
            >
              {entry.content}
            </span>
          </li>
        ))}
      </ul>
      {(hidden > 0 || expanded) && entries.length > PLAN_PREVIEW_ITEMS && (
        <button type="button" class="mt-1 text-[0.85rem] text-fg-muted hover:text-fg" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : `Show all (${entries.length})`}
        </button>
      )}
    </div>
  );
});
