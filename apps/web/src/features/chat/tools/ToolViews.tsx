/**
 * Collapsed tool call rows and tool-call groups.
 *
 *   <ToolCallRow part>   "Ran `ls -la`" — click to expand the tool's body renderer
 *   <ToolGroup part>     "Ran 4 tool calls · 12s" — click to expand into individual rows
 *
 * Durations (I-070) come from the server's timing stamps and tick live while running; old
 * history has none and shows none. Each tool kind has a colour (I-077, `data-tone` in chat.css):
 * the icon square and verb of a row, the kind icons of a group, and a running group's shimmer.
 */
import type { ComponentType } from "preact";
import { memo } from "preact/compat";
import { useState } from "preact/hooks";
import { ChevronRight, CircleX, Layers, type LucideProps } from "lucide-preact";
import type { ToolKind } from "@glade/protocol";
import { cn } from "@/lib/cn";
import { Spinner } from "@/ui";
import { formatDuration, groupDuration, toolDuration, useNow } from "../duration";
import { isActiveStatus, type GroupItem, type ToolCallPart, type ToolGroupPart } from "../grouping";
import { Markdown } from "../Markdown";
import { ThinkingView } from "../Thinking";
import { groupLabel, summarizeToolCall } from "./summaries";
import { rendererFor } from "./renderers";

/** Parts are rebuilt on every transcript change; compare what they point at instead. */
export function sameToolPart(a: ToolCallPart, b: ToolCallPart): boolean {
  return a.call === b.call && a.result === b.result && a.status === b.status;
}

export function sameGroupItem(a: GroupItem, b: GroupItem): boolean {
  if (a.type !== b.type || a.key !== b.key) return false;
  if (a.type === "tool") return sameToolPart(a, b as ToolCallPart);
  return a.text === (b as typeof a).text && a.streaming === (b as typeof a).streaming;
}

const rowClass =
  "group/row -mx-1.5 flex h-7 w-[calc(100%+12px)] items-center gap-2 rounded-control px-1.5 text-left outline-none hover:bg-hover disabled:hover:bg-transparent";

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      size={12}
      strokeWidth={2.5}
      class={cn("shrink-0 text-fg-subtle opacity-0 transition-transform group-hover/row:opacity-100", open && "rotate-90 opacity-100")}
    />
  );
}

/** A tool icon in a small square tinted with its kind's colour (chat.css `.pi-tone-icon`). */
function ToneIcon({ icon: Icon, tone, class: className }: { icon: ComponentType<LucideProps>; tone: ToolKind | "danger"; class?: string }) {
  return (
    <span class={cn("pi-tone-icon", className)} data-tone={tone} aria-hidden="true">
      <Icon size={12} strokeWidth={2.25} />
    </span>
  );
}

/** The kind of the call running now (else the last one still pending/streaming). */
export function currentKind(calls: ToolCallPart[]): ToolKind | null {
  let pending: ToolKind | null = null;
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]!;
    if (c.status === "running") return c.call.kind;
    if (pending === null && isActiveStatus(c.status)) pending = c.call.kind;
  }
  return pending;
}

/** Distinct kinds of a group's calls, in order of first use (write counts as edit). */
export function groupKinds(calls: ToolCallPart[], max = 6): ToolKind[] {
  const kinds: ToolKind[] = [];
  for (const c of calls) {
    const kind = c.call.kind === "write" ? "edit" : c.call.kind;
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return kinds.slice(0, max);
}

/** "Ran **6** tool calls": the count stands out; while running the label shimmers in the running tool's colour. */
function GroupLabel({ count, active, shimmer }: { count: number; active: boolean; shimmer: boolean }) {
  const label = groupLabel(count, active);
  const at = label.indexOf(String(count));
  if (shimmer || at === -1) return <span class={cn(shimmer && "pi-tone-shimmer")}>{label}</span>;
  return (
    <span>
      {label.slice(0, at)}
      <span class="font-medium text-fg-strong tabular-nums">{count}</span>
      {label.slice(at + String(count).length)}
    </span>
  );
}

/** Small icons of the kinds a group used. */
function KindStack({ kinds }: { kinds: ToolKind[] }) {
  if (kinds.length === 0) return null;
  return (
    <span class="ml-1.5 flex shrink-0 items-center gap-[3px]" aria-hidden="true">
      {kinds.map((kind) => {
        const Icon = rendererFor(kind).icon;
        return (
          <span key={kind} class="pi-tone-icon size-4 rounded-[4px]" data-tone={kind}>
            <Icon size={10} strokeWidth={2.25} />
          </span>
        );
      })}
    </span>
  );
}

export const ToolCallRow = memo(function ToolCallRow({ part, defaultOpen = false }: { part: ToolCallPart; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const { call, result, status } = part;
  const active = isActiveStatus(status);
  const summary = summarizeToolCall(call, active);
  const renderer = rendererFor(call.kind);
  const Icon = renderer.icon;
  const Badge = renderer.Badge;
  const expandable = status !== "streaming";
  const running = result?.status === "running" && result.startedAt !== undefined;
  const now = useNow(running, result?.startedAt);
  const duration = toolDuration(result, now);
  // Finished calls under a second show nothing (a column of "0s" is noise); running ones tick.
  const showDuration = duration !== null && (running || duration >= 1000);

  return (
    <div class="tool-call" data-status={status}>
      <button type="button" class={rowClass} aria-expanded={open} disabled={!expandable} onClick={() => setOpen(!open)}>
        <ToneIcon icon={Icon} tone={status === "error" ? "danger" : call.kind} class={cn(status === "cancelled" && "opacity-60")} />
        <span class={cn("min-w-0 flex-1 truncate", status === "cancelled" && "opacity-60")} data-tone={status === "error" ? "danger" : call.kind}>
          <span class="pi-tone-text">{summary.verb}</span>
          {summary.subject && (
            <>
              {" "}
              <span class={cn("text-fg", summary.mono && "font-mono text-[0.92em]")}>{summary.subject}</span>
            </>
          )}
        </span>
        {Badge && <Badge call={call} result={result} status={status} />}
        {showDuration && <span class="shrink-0 text-[0.85rem] text-fg-subtle tabular-nums">{formatDuration(duration)}</span>}
        {active && <Spinner size={12} />}
        {status === "error" && <CircleX size={13} class="shrink-0 text-danger" aria-label="Failed" />}
        {status === "cancelled" && <span class="text-[0.85rem] text-fg-subtle">Cancelled</span>}
        {expandable && <Chevron open={open} />}
      </button>
      {open && (
        <div class="mt-0.5 mb-2 pl-[22px]">
          <renderer.Body call={call} result={result} status={status} />
        </div>
      )}
    </div>
  );
}, (a, b) => sameToolPart(a.part, b.part));

function GroupItemView({ item }: { item: GroupItem }) {
  switch (item.type) {
    case "tool":
      return <ToolCallRow part={item} />;
    case "thinking":
      return <ThinkingView text={item.text} streaming={item.streaming} />;
    case "text":
      return <Markdown text={item.text} streaming={item.streaming} class="py-1 text-fg-muted" />;
  }
}

export const ToolGroup = memo(function ToolGroup({ part, defaultOpen = false }: { part: ToolGroupPart; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const count = part.calls.length;
  const results = part.calls.map((c) => c.result);
  const firstStart = results.reduce<number | null>((min, r) => (r?.startedAt !== undefined && (min === null || r.startedAt < min) ? r.startedAt : min), null);
  const now = useNow(part.active && firstStart !== null, firstStart);
  const duration = groupDuration(results, now, part.active);
  const current = part.active ? currentKind(part.calls) : null;
  const kinds = groupKinds(part.calls);
  return (
    <div class="tool-group">
      <button type="button" class={rowClass} aria-expanded={open} onClick={() => setOpen(!open)}>
        <ToneIcon icon={Layers} tone={current ?? (part.errorCount ? "danger" : "other")} />
        <span class="min-w-0 truncate text-fg-muted" data-tone={current ?? undefined}>
          <GroupLabel count={count} active={part.active} shimmer={current !== null} />
          {duration !== null && (part.active || duration >= 1000) && <span class="tabular-nums"> · {formatDuration(duration)}</span>}
          {part.errorCount > 0 && <span class="text-danger"> · {part.errorCount} failed</span>}
        </span>
        <KindStack kinds={kinds} />
        <span class="flex-1" />
        {part.active && <Spinner size={12} />}
        <Chevron open={open} />
      </button>
      {open && (
        <div class="mt-0.5 mb-1 ml-[6px] border-l border-separator pl-[13px]">
          {part.items.map((item) => (
            <GroupItemView key={item.key} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}, (a, b) => a.part.active === b.part.active && a.part.items.length === b.part.items.length && a.part.items.every((item, i) => sameGroupItem(item, b.part.items[i]!)));
