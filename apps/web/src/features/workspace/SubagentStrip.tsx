/**
 * Sub-agent summary strip (I-080), shown just above the main chat's composer while the chat has
 * sub-agents. One row ("chip") per agent: status icon, name, short model, latest activity and
 * elapsed time; clicking a row opens the agent in the right-hand pane (which stays closed until
 * then). The chevron on a row expands its task and, once done, its report (Markdown) + "Open".
 *
 * From `COLLAPSE_FROM` agents on it starts collapsed to one summary line ("3 agents · 2 working
 * · 1 done") with a compact pill per agent; expanding lists them all (done ones dimmed) with
 * "Stop all" for the running ones (aborts their current turns; they stay open).
 *
 *   <SubagentStrip subagents={…} openId={idShownInPane} onOpen={(id) => …} />
 *
 * Derivation lives in `agent-chips.ts`; this only renders.
 */
import { useState } from "preact/hooks";
import { Check, ChevronRight, OctagonAlert, PanelRight, Square } from "lucide-preact";
import type { SessionSummary } from "@glade/protocol";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import { runAction, useChatSession } from "@/state/chat-session";
import { models } from "@/state/store";
import { Button, IconButton, Spinner } from "@/ui";
import { formatDuration, useNow } from "@/features/chat/duration";
import { Markdown } from "@/features/chat/Markdown";
import { agentChip, chipKind, COLLAPSE_FROM, stripSummary, type AgentChip, type ChipKind } from "./agent-chips";

export interface SubagentStripProps {
  subagents: readonly SessionSummary[];
  /** The agent currently shown in the pane (highlighted), if the pane is open. */
  openId: string | null;
  onOpen: (sessionId: string) => void;
}

export function SubagentStrip({ subagents, openId, onOpen }: SubagentStripProps) {
  const many = subagents.length >= COLLAPSE_FROM;
  const [expanded, setExpanded] = useState(false);
  if (subagents.length === 0) return null;
  const kinds = subagents.map((s) => ({ id: s.id, kind: chipKind(s) }));
  const running = kinds.filter((k) => k.kind === "working" || k.kind === "blocked");
  const attention = kinds.some((k) => k.kind === "blocked") ? "warning" : kinds.some((k) => k.kind === "failed") ? "danger" : null;
  const stopAll = () => {
    for (const k of running) void runAction(() => api.abort(k.id), "Could not stop");
  };
  const listed = !many || expanded;
  return (
    <div
      role="region"
      aria-label="Sub-agents"
      data-subagent-strip
      class="mb-2 overflow-hidden rounded-[10px] border-[0.5px] border-separator bg-surface text-[0.92rem] select-none"
    >
      {many && (
        <div class={cn("flex h-8 items-center gap-1 pr-1.5", !expanded && attention === "warning" && "bg-warning-tint", !expanded && attention === "danger" && "bg-danger-tint")}>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            class="flex h-full shrink-0 items-center gap-1.5 pl-2.5 text-left text-fg-muted outline-none"
          >
            <ChevronRight size={12} strokeWidth={2.5} class={cn("shrink-0 text-fg-subtle transition-transform", expanded && "rotate-90")} />
            <span data-strip-summary>{stripSummary(kinds)}</span>
          </button>
          {!expanded ? (
            <div class="flex min-w-0 flex-1 items-center gap-1 overflow-hidden pl-1">
              {subagents.map((s) => (
                <AgentPill key={s.id} session={s} kind={kinds.find((k) => k.id === s.id)!.kind} selected={s.id === openId} onOpen={onOpen} />
              ))}
            </div>
          ) : (
            <span class="flex-1" />
          )}
          {expanded && running.length > 0 && (
            <Button size="sm" variant="ghost" onClick={stopAll} class="text-fg-muted">
              <Square class="size-3" /> Stop all
            </Button>
          )}
        </div>
      )}
      {listed && (
        <ul class={cn("flex flex-col", many && "border-t-[0.5px] border-separator")}>
          {subagents.map((s) => (
            <AgentRow key={s.id} session={s} dimDone={many} selected={s.id === openId} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusIcon({ kind }: { kind: ChipKind }) {
  switch (kind) {
    case "working":
    case "closing":
      return <Spinner size={11} />;
    case "blocked":
      return <span aria-hidden="true" class="size-2 shrink-0 rounded-full bg-warning" />;
    case "done":
      return <Check class="size-3.5 shrink-0 text-success" aria-hidden="true" />;
    case "failed":
      return <OctagonAlert class="size-3.5 shrink-0 text-danger" aria-hidden="true" />;
    case "idle":
      return <span aria-hidden="true" class="size-2 shrink-0 rounded-full border border-fg-subtle" />;
  }
}

/** Collapsed header: status + name, click opens. */
function AgentPill({ session, kind, selected, onOpen }: { session: SessionSummary; kind: ChipKind; selected: boolean; onOpen: (id: string) => void }) {
  const name = session.agentName || session.title || "Sub-agent";
  return (
    <button
      type="button"
      title={`Open ${name}`}
      aria-label={`Open ${name}`}
      data-agent-pill={kind}
      onClick={() => onOpen(session.id)}
      class={cn(
        "flex h-5 min-w-0 shrink items-center gap-1 rounded-full px-1.5 text-fg-muted outline-none hover:bg-hover",
        selected && "bg-selected text-fg",
        kind === "blocked" && "text-fg",
        kind === "failed" && "text-danger",
        kind === "done" && "opacity-60",
      )}
    >
      <StatusIcon kind={kind === "closing" ? "idle" : kind} />
      <span class="truncate">{name}</span>
    </button>
  );
}

function AgentRow({ session, dimDone, selected, onOpen }: { session: SessionSummary; dimDone: boolean; selected: boolean; onOpen: (id: string) => void }) {
  // Loads its transcript (for the activity line) without marking it as viewed.
  const store = useChatSession(session.id, { markViewing: false });
  const [open, setOpen] = useState(false);
  const kind = chipKind(session);
  const now = useNow(kind === "working" || kind === "blocked", session.createdAt);
  const chip: AgentChip = agentChip(session, store.status.value === "ready" ? store.transcript.value : null, models.value, now);
  const tooltip = [chip.task && `Task: ${chip.task}`, `${chip.label} — click to open`].filter(Boolean).join("\n");
  return (
    <li
      data-agent-chip={chip.kind}
      data-attention={chip.attention ?? undefined}
      class={cn(
        "border-t-[0.5px] border-separator first:border-t-0",
        chip.attention === "warning" && "bg-warning-tint",
        chip.attention === "danger" && "bg-danger-tint",
      )}
    >
      <div class={cn("group/row flex h-7 items-center pr-1", selected ? "bg-selected" : "hover:bg-hover", dimDone && chip.kind === "done" && "opacity-60")}>
        <button
          type="button"
          title={tooltip}
          aria-label={`Open ${chip.name} (${chip.label})`}
          onClick={() => onOpen(chip.id)}
          class="flex h-full min-w-0 flex-1 items-center gap-2 pl-2.5 text-left outline-none"
        >
          <span class="flex size-3.5 shrink-0 items-center justify-center">
            <StatusIcon kind={chip.kind} />
          </span>
          <span class={cn("shrink-0 font-medium text-fg-strong", chip.kind === "failed" && "text-danger")}>{chip.name}</span>
          {chip.attention && <span class={cn("shrink-0", chip.attention === "warning" ? "text-fg" : "text-danger")}>{chip.label}</span>}
          {chip.model && <span class="shrink-0 text-fg-subtle">{chip.model}</span>}
          <span class="min-w-0 flex-1 truncate text-fg-muted">{chip.activity}</span>
          <span class="shrink-0 text-fg-subtle tabular-nums">{formatDuration(chip.elapsedMs)}</span>
        </button>
        <IconButton size="sm" label={open ? "Hide details" : "Show details"} aria-expanded={open} tooltip={false} onClick={() => setOpen(!open)}>
          <ChevronRight class={cn("transition-transform", open && "rotate-90")} />
        </IconButton>
      </div>
      {open && (
        <div data-agent-details class="flex flex-col gap-2 border-t-[0.5px] border-separator px-3 py-2">
          {chip.task && (
            <p class="selectable text-fg-muted">
              <span class="text-fg-subtle">Task: </span>
              {chip.task}
            </p>
          )}
          {chip.result && (
            <div class="max-h-60 overflow-y-auto">
              <Markdown text={chip.result} />
            </div>
          )}
          {chip.kind === "closing" && <p class="text-fg-subtle">Closes when its turn ends.</p>}
          {session.agent?.status === "closed" && <p class="text-fg-subtle">Its process stopped. Open it and type a message to start it again.</p>}
          <div>
            <Button size="sm" onClick={() => onOpen(chip.id)}>
              <PanelRight class="size-3.5" /> Open
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
