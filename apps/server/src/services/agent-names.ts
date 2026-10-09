/**
 * Sub-agent identities (I-084): a fun human first name ("Maya", "Otis") and a colour
 * (`AGENT_COLORS`) assigned when an agent is spawned. Display-only: the functional name from
 * spawn_agent stays the id used by message_agent/close_agent.
 *
 * Rules: the name is unique among the workspace's active (not closed) sub-agents; among those, it
 * is picked at random from names no sub-agent of the same parent chat has had yet (its whole
 * history, closed ones included, I-144), and once every name has been used, the least recently
 * used one; the colour is unique among them while one is free, else one of the
 * least used. Closing an agent frees both (only active agents count). Stored on the session and
 * the agent record at spawn, so reloads and every client agree.
 *
 * An agent definition (I-218) can set the identity: its `nicknames` (the first one no active agent
 * of the workspace has; all taken → numbered, "Brandon 2"), its `color` (used even when another
 * agent has it) and its `icon`.
 */
import { AGENT_COLORS, type AgentColor, type AgentIcon } from "@glade/protocol";

/**
 * ~300 friendly, distinct, easy-to-read first names from varied origins (I-144). No two share
 * their first three letters, and none are one edit apart (except the older Arlo/Marlo; checked
 * by the tests).
 */
export const AGENT_DISPLAY_NAMES = [
  "Maya", "Otis", "Juniper", "Felix", "Hazel", "Milo", "Iris", "Theo", "Ruby", "Jasper",
  "Nora", "Oscar", "Luna", "Arlo", "Willow", "Finn", "Clara", "Hugo", "Poppy", "Leo",
  "Stella", "Rufus", "Ivy", "Gus", "Mabel", "Ezra", "Pearl", "Silas", "Wren", "Bruno",
  "Olive", "Remy", "Daisy", "Kit", "Greta", "Ollie", "Tessa", "Wally", "Esme", "Dexter",
  "Fern", "Nico", "Zelda", "Barney", "Lottie", "Rocco", "Ada", "Cosmo", "Bea", "Iggy",
  "Vera", "Sully", "Marlo", "Pip", "Quinn", "Frida", "Yuki", "Basil", "Coco", "Toby",
  "Aiko", "Akira", "Alma", "Amara", "Amos", "Anika", "Anton", "Aria", "Astrid", "Atlas",
  "Aurora", "Ayla", "Aziz", "Benji", "Bianca", "Birdie", "Blair", "Bodhi", "Bonnie", "Boris",
  "Bram", "Bridget", "Buster", "Cal", "Camila", "Carmen", "Cedric", "Celeste", "Chester", "Chloe",
  "Cyrus", "Colette", "Conrad", "Cruz", "Dahlia", "Dante", "Darcy", "Delia", "Diego", "Dima",
  "Dolly", "Donovan", "Duncan", "Dylan", "Eamon", "Eddie", "Edith", "Elio", "Elsa", "Emil",
  "Enzo", "Erin", "Etta", "Eunice", "Evander", "Evie", "Fabio", "Fatima", "Faye", "Fiona",
  "Flora", "Fox", "Franco", "Freddie", "Fumi", "Gemma", "Gideon", "Gilbert", "Gio", "Gloria",
  "Goldie", "Gordon", "Grace", "Gwen", "Hana", "Harper", "Hector", "Heidi", "Helga", "Henrik",
  "Hiro", "Honor", "Horace", "Hudson", "Ian", "Ilse", "Imani", "Imogen", "Indigo", "Inez",
  "Ingrid", "Isaac", "Jade", "Jalen", "Jamie", "Jin", "Joaquin", "Jonah", "Josie", "Jules",
  "Kai", "Kalani", "Kamal", "Karina", "Kasimir", "Keiko", "Kiki", "Klaus", "Kofi", "Kostas",
  "Kurt", "Lars", "Leila", "Liam", "Lionel", "Lorenzo", "Louie", "Lucia", "Ludo", "Lyra",
  "Magnus", "Malia", "Mateo", "Mei", "Mika", "Miriam", "Moss", "Mona", "Murphy", "Nadia",
  "Naomi", "Nash", "Ned", "Nell", "Niamh", "Nigel", "Nina", "Noah", "Noor", "Obi",
  "Odette", "Olaf", "Omar", "Opal", "Orla", "Orion", "Otto", "Paloma", "Pablo", "Paz",
  "Penny", "Percy", "Petra", "Philippa", "Priya", "Prue", "Rafa", "Raina", "Ramona", "Ravi",
  "Reggie", "Reza", "Rhea", "Rhys", "Rosa", "Roman", "Ryo", "Sage", "Sami", "Santi",
  "Sasha", "Selma", "Sergio", "Shiloh", "Sienna", "Signe", "Sol", "Sonia", "Soren", "Sven",
  "Sybil", "Tamsin", "Tariq", "Teddy", "Tilly", "Tomas", "Tova", "Trudy", "Tuck", "Uma",
  "Umberto", "Ursula", "Uriel", "Valentin", "Vance", "Vesna", "Vic", "Viggo", "Vilma", "Viola",
  "Vivian", "Wendell", "Winnie", "Wolf", "Wynn", "Xander", "Ximena", "Yara", "Yasmin", "Yelena",
  "Yosef", "Yusuf", "Yves", "Zadie", "Zain", "Zeke", "Zinnia", "Zola", "Zuri", "Adele",
  "Agnes", "Alvin", "Anders", "Angus", "Annie", "Archie", "Arjun", "August", "Cecil", "Chiara",
  "Cindy", "Desmond", "Elmer", "Emeka", "Esther", "Fitz", "Fleur", "Gabe", "Gaia", "Hattie",
  "Hamish", "Hilda", "Ike", "Isla", "Jett", "Keanu", "Mack", "Maxine", "Merle", "Pedro",
  "Ricky", "Seth", "Tabitha", "Ulla", "Yancy", "Zeno",
] as const;

export interface AgentIdentity {
  displayName: string;
  color: AgentColor;
  /** From the agent definition (I-218). */
  icon?: AgentIcon;
}

/** The identity an agent definition asks for (I-218); unset parts are picked as usual. */
export interface IdentityWish {
  nicknames?: readonly string[];
  color?: AgentColor | null;
  icon?: AgentIcon | null;
}

type Taken = { displayName?: string | null; color?: string | null };

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))]!;
}

/**
 * A name and colour for a new agent, given the identities of the workspace's other active agents
 * (`taken`) and the display names the parent chat's sub-agents have had so far, oldest first
 * (`history`, closed agents included). `wish` = the agent definition's identity (I-218). `random`
 * is injectable for tests.
 */
export function pickAgentIdentity(
  taken: readonly Taken[],
  history: readonly (string | null | undefined)[] = [],
  random: () => number = Math.random,
  wish: IdentityWish = {},
): AgentIdentity {
  const usedNames = new Set(taken.map((t) => t.displayName?.toLowerCase()).filter(Boolean));
  const nicknames = (wish.nicknames ?? []).map((n) => n.trim()).filter(Boolean);
  const displayName = nicknames.length ? pickNickname(nicknames, usedNames) : pickName(usedNames, history, random);
  const color = wish.color && (AGENT_COLORS as readonly string[]).includes(wish.color) ? wish.color : pickColor(taken, random);
  return { displayName, color, ...(wish.icon ? { icon: wish.icon } : {}) };
}

/** The first nickname no active agent has; all taken: the first one numbered ("Brandon 2"). */
function pickNickname(nicknames: readonly string[], usedNames: Set<string | undefined>): string {
  const free = nicknames.find((n) => !usedNames.has(n.toLowerCase()));
  if (free) return free;
  let n = 2;
  while (usedNames.has(`${nicknames[0]} ${n}`.toLowerCase())) n++;
  return `${nicknames[0]} ${n}`;
}

function pickName(usedNames: Set<string | undefined>, history: readonly (string | null | undefined)[], random: () => number): string {
  const freeNames = AGENT_DISPLAY_NAMES.filter((n) => !usedNames.has(n.toLowerCase()));
  // When each name was last used by this chat's sub-agents (index into `history`).
  const lastUsed = new Map<string, number>();
  history.forEach((n, i) => n && lastUsed.set(n.toLowerCase(), i));
  let displayName: string;
  const fresh = freeNames.filter((n) => !lastUsed.has(n.toLowerCase()));
  if (fresh.length) displayName = pick(fresh, random);
  else if (freeNames.length) {
    const oldest = Math.min(...freeNames.map((n) => lastUsed.get(n.toLowerCase())!));
    displayName = pick(
      freeNames.filter((n) => lastUsed.get(n.toLowerCase()) === oldest),
      random,
    );
  } else {
    // More active agents than names (not reachable with MAX_ACTIVE_AGENTS): number a name.
    const base = pick(AGENT_DISPLAY_NAMES, random);
    let n = 2;
    while (usedNames.has(`${base} ${n}`.toLowerCase())) n++;
    displayName = `${base} ${n}`;
  }
  return displayName;
}

function pickColor(taken: readonly Taken[], random: () => number): AgentColor {
  const uses = new Map<AgentColor, number>(AGENT_COLORS.map((c) => [c, 0]));
  for (const t of taken) if (t.color && uses.has(t.color as AgentColor)) uses.set(t.color as AgentColor, uses.get(t.color as AgentColor)! + 1);
  const least = Math.min(...uses.values());
  return pick(
    AGENT_COLORS.filter((c) => uses.get(c) === least),
    random,
  );
}
