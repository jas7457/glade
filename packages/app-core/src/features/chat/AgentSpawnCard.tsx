/**
 * A sub-agent's card where it was spawned (I-084): the parent's `task` tool call, linked to its
 * agent by `linkAgentSpawns` (agent-spawns.ts), renders in the agent's colour as "Maya ·
 * reviewer" (I-218: its icon and "Brandon · scout" with an agent definition; a harness badge when
 * it runs on another harness than this chat, I-217), status marker, latest activity and elapsed time; collapsed by default. Expanded:
 * the task, the latest activity while it runs and, once finished, its report (Markdown, the
 * same rendering as `AgentMessageCard`). "Open" shows it in the right-hand pane while it exists.
 * The agent's later messages to this chat are folded into the card (the transcript hides them).
 *
 * While the spawn call runs (no agent yet), the same card shows as a placeholder at once (I-145):
 * spinner, the functional name and agent definition from the call, "Starting an agent…". It
 * turns into the agent's card in place when the spawn returns.
 *
 * Task calls without a matching agent (other harnesses' tasks, failed spawns) fall back to the
 * generic tool row.
 *
 *   <SpawnLinksContext.Provider value={…}> … <AgentSpawnCard part={toolPart} />   (spawn-context.ts)
 */
import { useState } from "preact/hooks";
import { ArrowRight, Check, ChevronRight, Copy, PanelRight } from "lucide-preact";
import type { SessionSummary, Transcript } from "@glade/protocol";
import { cn } from "@glade/app-core/lib/cn";
import { isIphoneApp } from "@glade/app-core/lib/desktop";
import { useChatSession } from "@glade/app-core/state/chat-session";
import { IconButton } from "@glade/app-core/ui";
import { AgentStatusMarker } from "@glade/app-core/features/workspace/SubagentStrip";
import { formatDuration, useNow } from "./duration";
import { isActiveStatus, type ToolCallPart } from "./grouping";
import { useAgentLinks } from "./agent-links";
import { spawnCardState, spawnedAgentName, type SpawnCardState, type SpawnLink } from "./agent-spawns";
import { useSpawnLinks } from "./spawn-context";
import { Markdown } from "./Markdown";
import { AgentName } from "./AgentName";
import { ToolCallRow } from "./tools/ToolViews";

export function AgentSpawnCard({ part }: { part: ToolCallPart }) {
  const ctx = useSpawnLinks();
  const link = ctx?.links.byCall.get(part.call.id);
  if (!ctx || !link) {
    const name = spawnedAgentName(part.call);
    return name && isActiveStatus(part.status) ? <PendingSpawnCard name={name} definition={part.call.input?.agentDefinition?.trim() || null} /> : <ToolCallRow part={part} />;
  }
  const session = ctx.subagents.find((s) => s.id === link.ref.sessionId);
  return session ? <LiveSpawnCard part={part} link={link} session={session} /> : <SpawnCard part={part} link={link} session={undefined} transcript={null} />;
}

const cardClass = "my-2 overflow-hidden rounded-[10px] border-[0.5px] border-separator bg-surface shadow-[inset_3px_0_0_var(--pi-agent)]";

/** The spawn call is still running: no agent (fun name, colour) yet (I-145). Same frame as the card. */
function PendingSpawnCard({ name, definition }: { name: string; definition: string | null }) {
  return (
    <div data-role="agent-spawn" data-agent-color="" data-kind="starting" class={cardClass}>
      <div
        role="status"
        aria-label={`Starting an agent: ${name}${definition ? ` (${definition})` : ""}`}
        class="flex h-8 min-w-0 items-center gap-2 pr-1.5 pl-2.5 select-none"
      >
        <span class="flex size-3.5 shrink-0 items-center justify-center">
          <AgentStatusMarker kind="working" />
        </span>
        <span class="shrink-0 font-medium text-fg">{name}</span>
        {definition && <span class="shrink-0 text-fg-subtle">· {definition}</span>}
        <span class="min-w-0 flex-1 truncate text-fg-muted">Starting an agent…</span>
      </div>
    </div>
  );
}

/** While its session exists: its transcript feeds the live activity. */
function LiveSpawnCard({ part, link, session }: { part: ToolCallPart; link: SpawnLink; session: SessionSummary }) {
  const store = useChatSession(session.id, { markViewing: false });
  return <SpawnCard part={part} link={link} session={session} transcript={store.status.value === "ready" ? store.transcript.value : null} />;
}

function SpawnCard({ part, link, session, transcript }: { part: ToolCallPart; link: SpawnLink; session: SessionSummary | undefined; transcript: Transcript | null }) {
  const [open, setOpen] = useState(false);
  const callActive = isActiveStatus(part.status);
  const live = !!session && (session.status === "working" || session.status === "blocked" || session.agent?.status === "working");
  const now = useNow(live || (!session && callActive), session?.createdAt ?? link.ref.spawnedAt);
  const parentHarness = useSpawnLinks()?.parentHarness;
  const state = spawnCardState({ link, session, transcript, description: part.call.input?.description, callActive, now, parentHarness });
  const links = useAgentLinks();
  const canOpen = !!session && !!links;
  const openAgent = () => session && links?.openSession?.(session.id);
  const { identity } = state;
  return (
    <div
      data-role="agent-spawn"
      data-agent-color={identity.color}
      data-kind={state.kind}
      data-attention={state.attention ?? undefined}
      class={cn(
        cardClass,
        state.attention === "warning" && "bg-warning-tint",
        state.attention === "danger" && "bg-danger-tint",
      )}
    >
      <div class="group/row flex items-center gap-1 pr-1.5 hover:bg-hover">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${identity.displayName}${identity.role ? ` (${identity.role})` : ""}: ${state.label}`}
          onClick={() => setOpen(!open)}
          class="flex h-8 min-w-0 flex-1 items-center gap-2 pl-2.5 text-left outline-none"
        >
          <span class="flex size-3.5 shrink-0 items-center justify-center">
            <AgentStatusMarker kind={state.kind} />
          </span>
          <AgentName identity={identity} envId={session?.environmentId} />
          {state.attention && <span class={cn("shrink-0", state.attention === "warning" ? "text-fg" : "text-danger")}>{state.label}</span>}
          <span class="min-w-0 flex-1 truncate text-fg-muted">{open ? "" : state.latest}</span>
          <span class="shrink-0 text-fg-subtle tabular-nums" title={state.label}>
            {state.attention ? "" : `${state.label} · `}
            {formatDuration(state.elapsedMs)}
          </span>
          <ChevronRight size={12} strokeWidth={2.5} class={cn("shrink-0 text-fg-subtle transition-transform", open && "rotate-90")} />
        </button>
        {canOpen && (
          // The iPhone (I-164) opens it full screen, not in a pane: a bigger target and an arrow.
          <IconButton label={`Open ${identity.displayName}`} size={isIphoneApp() ? "md" : "sm"} onClick={openAgent}>
            {isIphoneApp() ? <ArrowRight /> : <PanelRight />}
          </IconButton>
        )}
      </div>
      {open && <SpawnCardDetails state={state} />}
    </div>
  );
}

function SpawnCardDetails({ state }: { state: SpawnCardState }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!state.report) return;
    void navigator.clipboard?.writeText(state.report).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div data-spawn-details class="flex flex-col gap-2 border-t-[0.5px] border-separator px-3.5 py-2.5">
      {state.task && (
        <p class="selectable line-clamp-4 whitespace-pre-wrap text-fg-muted">
          <span class="text-fg-subtle">Task: </span>
          {state.task}
        </p>
      )}
      {!state.report && state.latest && (
        <p class="selectable text-fg-muted">
          <span class="text-fg-subtle">{state.running ? "Now: " : "Latest: "}</span>
          {state.latest}
        </p>
      )}
      {state.report && (
        <div class="relative">
          <div class="absolute top-0 right-0">
            <IconButton label={copied ? "Copied" : "Copy report"} size="sm" onClick={copy}>
              {copied ? <Check /> : <Copy />}
            </IconButton>
          </div>
          <Markdown text={state.report} />
        </div>
      )}
      {state.note && <p class="selectable text-[0.88rem] leading-[1.45] text-fg-subtle">{state.note}</p>}
    </div>
  );
}
