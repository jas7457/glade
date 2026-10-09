/**
 * What a transcript knows about its chat's sub-agents (I-084), provided by `Transcript` to the
 * spawn cards (`AgentSpawnCard`) and the fallback report cards (`AgentMessageCard`): which tool
 * calls spawned which agent, the agents' sessions that still exist, and every agent's identity
 * (fun name + colour), also after it closed.
 */
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { SessionSummary, SpawnedAgentRef } from "@glade/protocol";
import { refAgentIdentity, sessionAgentIdentity, type AgentIdentityView } from "./agent-identity";
import type { AgentSpawnLinks } from "./agent-spawns";

export interface SpawnLinksValue {
  links: AgentSpawnLinks;
  /** The chat's sub-agent sessions that still exist. */
  subagents: readonly SessionSummary[];
  /** The chat's `SessionSummary.spawnedAgents`. */
  refs: readonly SpawnedAgentRef[];
  /** The chat's own harness (I-217: agents on another one are labelled). */
  parentHarness?: string | null;
}

export const SpawnLinksContext = createContext<SpawnLinksValue | null>(null);

export function useSpawnLinks(): SpawnLinksValue | null {
  return useContext(SpawnLinksContext);
}

/** Identity of the chat's latest sub-agent called `name` (live session first), or null. */
export function identityFor(value: SpawnLinksValue | null, name: string): AgentIdentityView | null {
  if (!value) return null;
  const live = [...value.subagents].reverse().find((s) => s.agentName === name);
  if (live) return sessionAgentIdentity(live, value.parentHarness);
  const ref = [...value.refs].reverse().find((r) => r.name === name);
  return ref ? refAgentIdentity(ref, value.parentHarness) : null;
}
