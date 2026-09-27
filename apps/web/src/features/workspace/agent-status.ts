/**
 * Sub-agent state for display (I-054): what a sub-agent tab shows, from `SessionSummary.agent`
 * (pushed by the server with every `session_upsert`). Pure, so it's unit-tested.
 *
 * A sub-agent that closes normally (report_done, close_agent, idle timeout) is deleted by the
 * server, so its tab simply disappears; `closed` only shows for one whose process stopped
 * (crashed) and whose tab stays so the error is readable.
 */
import type { SessionSummary } from "@glade/protocol";

export type AgentDisplayKind = "working" | "blocked" | "done" | "closing" | "closed" | "idle";

export interface AgentDisplay {
  kind: AgentDisplayKind;
  /** Short label, e.g. "Done". */
  label: string;
  /** Tab tooltip: name, status, task and result. */
  tooltip: string;
}

/** `null` for sessions that aren't agent-API sub-agents. */
export function agentDisplay(session: Pick<SessionSummary, "title" | "agentName" | "agentDisplayName" | "status" | "agent">): AgentDisplay | null {
  const agent = session.agent;
  if (!agent) return null;
  const kind: AgentDisplayKind =
    session.status === "blocked"
      ? "blocked"
      : agent.closing
        ? "closing"
        : agent.status === "closed"
          ? "closed"
          : session.status === "working" || agent.status === "working"
            ? "working"
            : agent.status === "done"
              ? "done"
              : "idle";
  const label = LABELS[kind];
  // "Maya · reviewer" once it has a fun name (I-084).
  const base = session.title || session.agentName || "Sub-agent";
  const name = session.agentDisplayName ? `${session.agentDisplayName} · ${base}` : base;
  const lines = [`${name}${agent.agent ? ` (${agent.agent})` : ""} — ${label}`];
  if (agent.keepOpenReason && kind === "done") lines.push(`Kept open for: ${agent.keepOpenReason}`);
  lines.push(`Task: ${clip(agent.task, 300)}`);
  if (agent.result) lines.push(`Result: ${clip(agent.result, 600)}`);
  return { kind, label, tooltip: lines.join("\n") };
}

const LABELS: Record<AgentDisplayKind, string> = {
  working: "Working…",
  blocked: "Needs your input",
  done: "Done",
  closing: "Closing…",
  closed: "Stopped",
  idle: "Idle",
};

function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
