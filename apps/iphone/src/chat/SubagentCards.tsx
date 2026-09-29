/**
 * A chat's sub-agents on the iPhone (I-164, doc §5.3): no side panes, so each agent is a card
 * above the composer (a row that scrolls sideways when there are several): its fun name in its
 * colour, status marker and label, and its latest activity. Tapping a card opens the agent's
 * chat full screen (`onOpen`). Same derivation as the desktop's chips (`agentChip`).
 */
import { ChevronRight } from "lucide-preact";
import type { SessionSummary } from "@glade/protocol";
import { cn } from "@/lib/cn";
import { useChatSession } from "@/state/chat-session";
import { envIdOfSession, shellOf } from "@/state/store";
import { useNow } from "@/features/chat/duration";
import { agentChip, chipKind } from "@/features/workspace/agent-chips";
import { AgentStatusMarker } from "@/features/workspace/SubagentStrip";

export function SubagentCards({ subagents, onOpen }: { subagents: readonly SessionSummary[]; onOpen: (sessionId: string) => void }) {
  if (subagents.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Sub-agents"
      data-subagent-cards
      class="-mx-2 mb-2 flex snap-x gap-2 overflow-x-auto px-2 pb-0.5 select-none [scrollbar-width:none]"
    >
      {subagents.map((s) => (
        <SubagentCard key={s.id} session={s} single={subagents.length === 1} onOpen={onOpen} />
      ))}
    </div>
  );
}

function SubagentCard({ session, single, onOpen }: { session: SessionSummary; single: boolean; onOpen: (id: string) => void }) {
  // Loads its transcript (for the activity line) without marking it as viewed.
  const store = useChatSession(session.id, { markViewing: false });
  const kind = chipKind(session);
  const now = useNow(kind === "working" || kind === "blocked", session.createdAt);
  const chip = agentChip(session, store.status.value === "ready" ? store.transcript.value : null, shellOf(envIdOfSession(session.id)).models.value, now);
  const { identity } = chip;
  return (
    <button
      type="button"
      aria-label={`Open ${identity.displayName} (${chip.label})`}
      data-agent-card={chip.kind}
      data-agent-color={identity.color}
      onClick={() => onOpen(chip.id)}
      class={cn(
        "flex min-h-14 shrink-0 snap-start items-center gap-2.5 rounded-xl border-[0.5px] border-separator bg-surface py-2 pr-2 pl-3 text-left shadow-[inset_3px_0_0_var(--pi-agent)] active:bg-hover",
        single ? "w-full" : "w-[78%] max-w-80",
        chip.attention === "warning" && "border-warning/60 bg-warning-tint",
        chip.attention === "danger" && "border-danger/50 bg-danger-tint",
      )}
    >
      <span class="flex w-4 shrink-0 justify-center">
        <AgentStatusMarker kind={chip.kind} size={13} />
      </span>
      <span class="min-w-0 flex-1">
        <span class="flex items-baseline gap-1.5 text-[15px]">
          <span class="shrink-0 font-semibold text-agent">{identity.displayName}</span>
          {identity.role && <span class="truncate text-fg-subtle">{identity.role}</span>}
          <span class={cn("ml-auto shrink-0 text-[13px]", chip.attention === "danger" ? "text-danger" : chip.attention === "warning" ? "text-fg" : "text-fg-muted")}>
            {chip.label}
          </span>
        </span>
        <span class="block truncate text-[13px] text-fg-muted">{chip.activity || chip.task || " "}</span>
      </span>
      <ChevronRight size={18} class="shrink-0 text-fg-subtle" aria-hidden="true" />
    </button>
  );
}
