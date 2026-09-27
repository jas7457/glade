/**
 * One-line bar above a sub-agent's conversation (I-054) once it has something to say about its
 * state: done (with its report_done result, expandable), closing, or stopped. Hidden while it
 * works normally (the tab shows that).
 *
 *   <AgentBar session={subagentSummary} />
 */
import { useState } from "preact/hooks";
import { Check, ChevronRight, CircleSlash } from "lucide-preact";
import type { SessionSummary } from "@glade/protocol";
import { cn } from "@/lib/cn";
import { Spinner } from "@/ui";
import { agentDisplay } from "./agent-status";

export function AgentBar({ session }: { session: SessionSummary }) {
  const [open, setOpen] = useState(false);
  const display = agentDisplay(session);
  if (!display || !["done", "closing", "closed"].includes(display.kind)) return null;
  const result = session.agent?.result?.trim() || null;
  const icon =
    display.kind === "done" ? (
      <Check class="size-3.5 text-success" />
    ) : display.kind === "closing" ? (
      <Spinner size={11} />
    ) : (
      <CircleSlash class="size-3.5 text-fg-muted" />
    );
  const note =
    display.kind === "closed" ? "Its process stopped. Type a message to start it again." : display.kind === "closing" ? "This tab closes when its turn ends." : null;
  return (
    <div data-agent-bar={display.kind} class="shrink-0 border-b-[0.5px] border-separator bg-tabbar text-[0.92rem] select-none">
      <button
        type="button"
        aria-expanded={result ? open : undefined}
        disabled={!result}
        onClick={() => setOpen(!open)}
        title={display.tooltip}
        class="flex h-7 w-full min-w-0 items-center gap-1.5 px-2.5 text-left outline-none"
      >
        {icon}
        <span class="shrink-0 font-medium text-fg">{display.label}</span>
        {(result || note) && <span class="min-w-0 flex-1 truncate text-fg-muted">{open ? "" : (result ?? note)}</span>}
        {result && <ChevronRight class={cn("size-3 shrink-0 text-fg-muted transition-transform", open && "rotate-90")} />}
      </button>
      {open && result && (
        <div class="max-h-48 overflow-y-auto px-2.5 pb-2 whitespace-pre-wrap text-fg select-text">{result}</div>
      )}
    </div>
  );
}
