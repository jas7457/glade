/**
 * How a sub-agent is shown (I-084): its fun display name ("Maya"), its functional name
 * ("reviewer", greyed next to it) and its colour key (`AGENT_COLORS`, rendered with
 * `data-agent-color`, see styles.css). Agents from before I-084 have neither a display name nor
 * a colour: they show their functional name and a colour derived from their id, so it's stable.
 */
import { AGENT_COLORS, type AgentColor } from "@glade/protocol";

export interface AgentIdentityView {
  /** Fun name, else the functional name. */
  displayName: string;
  /** Functional name (the id used by message_agent), or null when it equals the display name. */
  role: string | null;
  color: AgentColor;
}

/** A stable colour for an id (agents without an assigned colour). */
export function derivedAgentColor(id: string): AgentColor {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AGENT_COLORS[h % AGENT_COLORS.length]!;
}

export function agentColorKey(color: string | null | undefined, id: string): AgentColor {
  return (AGENT_COLORS as readonly string[]).includes(color ?? "") ? (color as AgentColor) : derivedAgentColor(id);
}

export interface IdentitySource {
  /** Session id (or the agent's session id for refs). */
  id: string;
  name: string | null | undefined;
  displayName?: string | null;
  color?: string | null;
}

export function agentIdentity(src: IdentitySource): AgentIdentityView {
  const name = src.name?.trim() || "Sub-agent";
  const displayName = src.displayName?.trim() || name;
  return { displayName, role: displayName === name ? null : name, color: agentColorKey(src.color, src.id) };
}

/** Identity of a sub-agent session (`SessionSummary`). */
export function sessionAgentIdentity(s: { id: string; agentName: string | null; title?: string; agentDisplayName?: string; agentColor?: string }): AgentIdentityView {
  return agentIdentity({ id: s.id, name: s.agentName || s.title, displayName: s.agentDisplayName, color: s.agentColor });
}

/** "Maya · reviewer" (or just the name). */
export function agentLabel(identity: AgentIdentityView): string {
  return identity.role ? `${identity.displayName} · ${identity.role}` : identity.displayName;
}
