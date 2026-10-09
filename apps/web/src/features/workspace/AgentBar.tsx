/**
 * One-line bar above a sub-agent's conversation (I-054; always shown since I-084): the agent's
 * fun name in its colour with its role greyed ("Maya · reviewer"; I-218: its icon and "Brandon ·
 * scout"; I-217: a harness badge when it isn't the parent's), its status, and once done its
 * report_done result (expandable), or a note while closing / after its process stopped. Its ⋯
 * menu has "Remove Sub-agent…" (I-141; confirmed, the tab itself has no ×).
 *
 *   <AgentBar session={subagentSummary} />
 */
import { useState } from "preact/hooks";
import { Check, ChevronRight, CircleSlash, Ellipsis, Trash2 } from "lucide-preact";
import type { SessionSummary } from "@glade/protocol";
import { cn } from "@glade/app-core/lib/cn";
import { IconButton, Menu, MenuItem, Spinner } from "@glade/app-core/ui";
import { sessionAgentIdentity } from "@glade/app-core/features/chat/agent-identity";
import { AgentName } from "@glade/app-core/features/chat/AgentName";
import { agentDisplay } from "./agent-status";
import { removeSubagent } from "./layout-actions";

export function AgentBar({ session }: { session: SessionSummary }) {
  const [open, setOpen] = useState(false);
  const display = agentDisplay(session);
  if (!display) return null;
  const identity = sessionAgentIdentity(session);
  const result = display.kind === "done" ? session.agent?.result?.trim() || null : null;
  const icon =
    display.kind === "done" ? (
      <Check class="size-3.5 text-success" />
    ) : display.kind === "closing" || display.kind === "working" ? (
      <span class="flex text-agent">
        <Spinner size={11} class="text-current" />
      </span>
    ) : display.kind === "blocked" ? (
      <span class="size-[7px] rounded-full bg-warning" />
    ) : display.kind === "closed" ? (
      <CircleSlash class="size-3.5 text-fg-muted" />
    ) : null;
  // I-188: the harness's own sub-agent never starts again; say why it stopped instead.
  const native = session.agent?.native;
  const note =
    display.kind === "closed"
      ? native
        ? session.agent?.result?.trim() || `${native} stopped it.`
        : "Its process stopped. Type a message to start it again."
      : display.kind === "closing"
        ? "This tab closes when its turn ends."
        : null;
  return (
    <div
      data-agent-bar={display.kind}
      data-agent-color={identity.color}
      class="shrink-0 border-b-[0.5px] border-separator bg-tabbar text-[0.92rem] select-none"
    >
      <div class="flex min-w-0 items-center pr-1">
        <button
          type="button"
          aria-expanded={result ? open : undefined}
          disabled={!result}
          onClick={() => setOpen(!open)}
          title={display.tooltip}
          class="flex h-7 min-w-0 flex-1 items-center gap-1.5 px-2.5 text-left outline-none"
        >
          {!identity.icon && <span aria-hidden="true" class="size-2 shrink-0 rounded-full bg-agent" />}
          <AgentName identity={identity} envId={session.environmentId} />
          <span class="w-1 shrink-0" />
          {icon}
          <span class="shrink-0 text-fg">{display.label}</span>
          {(result || note) && <span class="min-w-0 flex-1 truncate text-fg-muted">{open ? "" : (result ?? note)}</span>}
          {result && <ChevronRight class={cn("size-3 shrink-0 text-fg-muted transition-transform", open && "rotate-90")} />}
        </button>
        <Menu
          align="end"
          trigger={
            <IconButton size="sm" label="Agent Actions" class="size-5">
              <Ellipsis />
            </IconButton>
          }
        >
          <MenuItem icon={<Trash2 />} destructive onSelect={() => void removeSubagent(session)}>
            Remove Sub-agent…
          </MenuItem>
        </Menu>
      </div>
      {open && result && (
        <div class="max-h-48 overflow-y-auto px-2.5 pb-2 whitespace-pre-wrap text-fg select-text">{result}</div>
      )}
    </div>
  );
}
