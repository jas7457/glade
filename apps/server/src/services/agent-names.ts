/**
 * Sub-agent identities (I-084): a fun human first name ("Maya", "Otis") and a colour
 * (`AGENT_COLORS`) assigned when an agent is spawned. Display-only: the functional name from
 * spawn_agent stays the id used by message_agent/close_agent.
 *
 * Rules: the name is unique among the workspace's active (not closed) sub-agents, picked at
 * random from the unused ones; the colour is unique among them while one is free, else one of the
 * least used. Closing an agent frees both (only active agents count). Stored on the session and
 * the agent record at spawn, so reloads and every client agree.
 */
import { AGENT_COLORS, type AgentColor } from "@glade/protocol";

/** Friendly, distinct, easy-to-read first names (no two share their first three letters). */
export const AGENT_DISPLAY_NAMES = [
  "Maya", "Otis", "Juniper", "Felix", "Hazel", "Milo", "Iris", "Theo", "Ruby", "Jasper",
  "Nora", "Oscar", "Luna", "Arlo", "Willow", "Finn", "Clara", "Hugo", "Poppy", "Leo",
  "Stella", "Rufus", "Ivy", "Gus", "Mabel", "Ezra", "Pearl", "Silas", "Wren", "Bruno",
  "Olive", "Remy", "Daisy", "Kit", "Greta", "Ollie", "Tessa", "Wally", "Esme", "Dexter",
  "Fern", "Nico", "Zelda", "Barney", "Lottie", "Rocco", "Ada", "Cosmo", "Bea", "Iggy",
  "Vera", "Sully", "Marlo", "Pip", "Quinn", "Frida", "Yuki", "Basil", "Coco", "Toby",
] as const;

export interface AgentIdentity {
  displayName: string;
  color: AgentColor;
}

type Taken = { displayName?: string | null; color?: string | null };

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))]!;
}

/**
 * A name and colour for a new agent, given the identities of the workspace's other active agents.
 * `random` is injectable for tests.
 */
export function pickAgentIdentity(taken: readonly Taken[], random: () => number = Math.random): AgentIdentity {
  const usedNames = new Set(taken.map((t) => t.displayName?.toLowerCase()).filter(Boolean));
  const freeNames = AGENT_DISPLAY_NAMES.filter((n) => !usedNames.has(n.toLowerCase()));
  let displayName: string;
  if (freeNames.length) displayName = pick(freeNames, random);
  else {
    // More active agents than names (not reachable with MAX_ACTIVE_AGENTS): number a name.
    const base = pick(AGENT_DISPLAY_NAMES, random);
    let n = 2;
    while (usedNames.has(`${base} ${n}`.toLowerCase())) n++;
    displayName = `${base} ${n}`;
  }
  const uses = new Map<AgentColor, number>(AGENT_COLORS.map((c) => [c, 0]));
  for (const t of taken) if (t.color && uses.has(t.color as AgentColor)) uses.set(t.color as AgentColor, uses.get(t.color as AgentColor)! + 1);
  const least = Math.min(...uses.values());
  const color = pick(
    AGENT_COLORS.filter((c) => uses.get(c) === least),
    random,
  );
  return { displayName, color };
}
