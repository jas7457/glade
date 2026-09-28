/**
 * Sub-agent chips (I-080, compact since I-084), shown just above the main chat's composer while
 * the chat has sub-agents: small chips side by side (wrapping when needed), one per agent, in
 * the agent's colour with its fun name, a tiny status marker (spinner / needs input / ✓ /
 * failed) and its latest activity truncated (full text, role and task in the tooltip). Needs
 * input / failed chips are tinted amber / red. Clicking a chip opens the agent in the
 * right-hand pane (which stays closed until then). While any agent runs, a small "…" button at
 * the end offers "Stop All" (aborts their current turns; they stay open).
 *
 *   <SubagentStrip subagents={…} openId={idShownInPane} onOpen={(id) => …} />
 *
 * Derivation lives in `agent-chips.ts`; this only renders.
 */
import { Check, Ellipsis, OctagonAlert, Square } from "lucide-preact";
import type { SessionSummary } from "@glade/protocol";
import { cn } from "@/lib/cn";
import { apiForSession } from "@/state/env-api";
import { runAction, useChatSession } from "@/state/chat-session";
import { envIdOfSession, shellOf } from "@/state/store";
import { IconButton, Menu, MenuItem, Spinner } from "@/ui";
import { agentLabel } from "@/features/chat/agent-identity";
import { formatDuration, useNow } from "@/features/chat/duration";
import { agentChip, chipKind, type ChipKind } from "./agent-chips";

export interface SubagentStripProps {
  subagents: readonly SessionSummary[];
  /** The agent currently shown in the pane (highlighted), if the pane is open. */
  openId: string | null;
  onOpen: (sessionId: string) => void;
}

export function SubagentStrip({ subagents, openId, onOpen }: SubagentStripProps) {
  if (subagents.length === 0) return null;
  const running = subagents.filter((s) => {
    const kind = chipKind(s);
    return kind === "working" || kind === "blocked";
  });
  const stopAll = () => {
    for (const s of running) void runAction(() => apiForSession(s.id).abort(s.id), "Could not stop");
  };
  return (
    <div role="region" aria-label="Sub-agents" data-subagent-strip class="mb-2 flex flex-wrap items-center gap-1 text-[0.88rem] select-none">
      {subagents.map((s) => (
        <AgentChipView key={s.id} session={s} selected={s.id === openId} onOpen={onOpen} />
      ))}
      {running.length > 0 && (
        <Menu
          align="end"
          side="top"
          trigger={
            <IconButton size="sm" label="Sub-agent actions" class="size-[22px]">
              <Ellipsis />
            </IconButton>
          }
        >
          <MenuItem icon={<Square />} onSelect={stopAll}>
            Stop All ({running.length})
          </MenuItem>
        </Menu>
      )}
    </div>
  );
}

/** Tiny status marker of a chip or spawn card. */
export function AgentStatusMarker({ kind, size = 11 }: { kind: ChipKind; size?: number }) {
  switch (kind) {
    case "working":
    case "closing":
      return (
        <span class="flex text-agent" data-status-marker={kind}>
          <Spinner size={size} class="text-current" />
        </span>
      );
    case "blocked":
      return <span aria-hidden="true" data-status-marker={kind} class="size-[7px] shrink-0 rounded-full bg-warning" />;
    case "done":
      return <Check size={size + 1} strokeWidth={2.5} aria-hidden="true" data-status-marker={kind} class="shrink-0 text-success" />;
    case "failed":
      return <OctagonAlert size={size + 1} aria-hidden="true" data-status-marker={kind} class="shrink-0 text-danger" />;
    case "idle":
      return <span aria-hidden="true" data-status-marker={kind} class="size-[7px] shrink-0 rounded-full border border-fg-subtle" />;
  }
}

function AgentChipView({ session, selected, onOpen }: { session: SessionSummary; selected: boolean; onOpen: (id: string) => void }) {
  // Loads its transcript (for the activity text) without marking it as viewed.
  const store = useChatSession(session.id, { markViewing: false });
  const kind = chipKind(session);
  const now = useNow(kind === "working" || kind === "blocked", session.createdAt);
  const chip = agentChip(session, store.status.value === "ready" ? store.transcript.value : null, shellOf(envIdOfSession(session.id)).models.value, now);
  const tooltip = [
    `${agentLabel(chip.identity)} — ${chip.label} · ${formatDuration(chip.elapsedMs)}${chip.model ? ` · ${chip.model}` : ""}`,
    chip.activity,
    chip.task && `Task: ${chip.task}`,
    "Click to open",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <button
      type="button"
      title={tooltip}
      aria-label={`Open ${chip.identity.displayName} (${chip.label})`}
      aria-pressed={selected}
      data-agent-chip={chip.kind}
      data-agent-color={chip.identity.color}
      data-attention={chip.attention ?? undefined}
      onClick={() => onOpen(chip.id)}
      class={cn(
        // Fixed width (the user asked): chips don't jump as their latest message changes.
        "flex h-[22px] w-44 max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-full text-left border-[0.5px] border-separator bg-agent-tint pr-2 pl-1.5 outline-none hover:bg-hover",
        chip.attention === "warning" && "border-warning/60 bg-warning-tint",
        chip.attention === "danger" && "border-danger/50 bg-danger-tint",
        selected && "border-agent ring-1 ring-agent",
        (chip.kind === "done" || chip.kind === "idle") && !selected && "opacity-80",
      )}
    >
      {/* The status marker leads (spinner / needs input / check / failed / idle); the name carries the colour (I-103). */}
      <span class="flex w-3 shrink-0 justify-center">
        <AgentStatusMarker kind={chip.kind} size={10} />
      </span>
      <span class="shrink-0 font-medium text-agent">{chip.identity.displayName}</span>
      {chip.shortActivity && (
        <span class={cn("min-w-0 flex-1 truncate", chip.attention === "danger" ? "text-danger" : chip.attention === "warning" ? "text-fg" : "text-fg-muted")}>
          {chip.shortActivity}
        </span>
      )}
    </button>
  );
}
