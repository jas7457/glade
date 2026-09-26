/**
 * Collapsed tool call rows and tool-call groups.
 *
 *   <ToolCallRow part>   "Ran `ls -la`" — click to expand the tool's body renderer
 *   <ToolGroup part>     "Ran 4 tool calls" — click to expand into individual rows
 */
import { memo } from "preact/compat";
import { useState } from "preact/hooks";
import { ChevronRight, CircleX, Layers } from "lucide-preact";
import { cn } from "@/lib/cn";
import { Spinner } from "@/ui";
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

export const ToolCallRow = memo(function ToolCallRow({ part, defaultOpen = false }: { part: ToolCallPart; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const { call, result, status } = part;
  const active = isActiveStatus(status);
  const summary = summarizeToolCall(call, active);
  const renderer = rendererFor(call.name);
  const Icon = renderer.icon;
  const Badge = renderer.Badge;
  const expandable = status !== "streaming";

  return (
    <div class="tool-call" data-status={status}>
      <button type="button" class={rowClass} aria-expanded={open} disabled={!expandable} onClick={() => setOpen(!open)}>
        <Icon size={14} class={cn("shrink-0", status === "error" ? "text-danger" : "text-fg-subtle")} />
        <span class={cn("min-w-0 flex-1 truncate", status === "cancelled" && "opacity-60")}>
          <span class="text-fg-muted">{summary.verb}</span>
          {summary.subject && (
            <>
              {" "}
              <span class={cn("text-fg", summary.mono && "font-mono text-[0.92em]")}>{summary.subject}</span>
            </>
          )}
        </span>
        {Badge && <Badge call={call} result={result} status={status} />}
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
  return (
    <div class="tool-group">
      <button type="button" class={rowClass} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Layers size={14} class={cn("shrink-0", part.errorCount ? "text-danger" : "text-fg-subtle")} />
        <span class="min-w-0 flex-1 truncate text-fg-muted">
          {groupLabel(count, part.active)}
          {part.errorCount > 0 && <span class="text-danger"> · {part.errorCount} failed</span>}
        </span>
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
