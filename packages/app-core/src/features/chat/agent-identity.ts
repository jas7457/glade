/**
 * How a sub-agent is shown (I-084): its fun display name ("Maya"), its functional name
 * ("reviewer", greyed next to it) and its colour key (`AGENT_COLORS`, rendered with
 * `data-agent-color`, see styles.css). Agents from before I-084 have neither a display name nor
 * a colour: they show their functional name and a colour derived from their id, so it's stable.
 *
 * I-218: an agent started from an agent definition shows the definition's name greyed instead
 * ("Brandon · scout") and the definition's icon, when it has one. I-217: when it runs on another
 * harness than its parent chat, `harness` names it (a calm badge / tooltip next to the name).
 */
import { AGENT_COLORS, AGENT_ICONS, type AgentColor, type AgentIcon, type SpawnedAgentRef } from "@glade/protocol";
import { sessionsById } from "@glade/app-core/state/store";

export interface AgentIdentityView {
  /** Fun name, else the functional name. */
  displayName: string;
  /**
   * The agent definition's name (I-218), else the functional name (the id used by message_agent);
   * null when it equals the display name.
   */
  role: string | null;
  color: AgentColor;
  /** The definition's icon (I-218), or null (today's look). */
  icon: AgentIcon | null;
  /** Harness id it runs on when that isn't its parent chat's (I-217), else null. */
  harness: string | null;
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
  /** Agent definition name (I-218). */
  definition?: string | null;
  icon?: string | null;
  /** The harness it runs on (I-217) … */
  harness?: string | null;
  /** … and its parent's: a badge only when both are known and differ. */
  parentHarness?: string | null;
}

export function agentIdentity(src: IdentitySource): AgentIdentityView {
  const name = src.name?.trim() || "Sub-agent";
  const displayName = src.displayName?.trim() || name;
  const role = src.definition?.trim() || name;
  const icon = (AGENT_ICONS as readonly string[]).includes(src.icon ?? "") ? (src.icon as AgentIcon) : null;
  const harness = src.harness && src.parentHarness && src.harness !== src.parentHarness ? src.harness : null;
  return { displayName, role: displayName === role ? null : role, color: agentColorKey(src.color, src.id), icon, harness };
}

type IdentitySession = {
  id: string;
  agentName: string | null;
  title?: string;
  agentDisplayName?: string;
  agentColor?: string;
  agentIcon?: string;
  harness?: string;
  parentSessionId?: string | null;
  agent?: { agent: string | null } | null;
};

/**
 * Identity of a sub-agent session (`SessionSummary`). The parent's harness is looked up in the
 * session store unless given.
 */
export function sessionAgentIdentity(s: IdentitySession, parentHarness?: string | null): AgentIdentityView {
  const parent = parentHarness !== undefined ? parentHarness : s.parentSessionId ? sessionsById.value.get(s.parentSessionId)?.harness : null;
  return agentIdentity({
    id: s.id,
    name: s.agentName || s.title,
    displayName: s.agentDisplayName,
    color: s.agentColor,
    definition: s.agent?.agent,
    icon: s.agentIcon,
    harness: s.harness,
    parentHarness: parent,
  });
}

/** Identity of a spawned agent from its record (its session may be gone; I-084, I-218). */
export function refAgentIdentity(ref: SpawnedAgentRef, parentHarness?: string | null): AgentIdentityView {
  return agentIdentity({
    id: ref.sessionId,
    name: ref.name,
    displayName: ref.displayName,
    color: ref.color,
    definition: ref.agent,
    icon: ref.icon,
    harness: ref.harness,
    parentHarness,
  });
}

/** "Maya · reviewer" (or just the name). */
export function agentLabel(identity: AgentIdentityView): string {
  return identity.role ? `${identity.displayName} · ${identity.role}` : identity.displayName;
}
