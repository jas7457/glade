/** Settings section metadata (labels + icons) and the sidebar categories they're grouped in. */
import { BookText, Cpu, Globe, Palette, Settings2, SlashSquare, SquareTerminal } from "lucide-preact";
import type { SettingsSection } from "@/app/routes";
import { hostHarnesses as harnesses } from "@/state/host-settings";

/**
 * The agent section is named after the installed harness ("pi"), or "Agents" when there are
 * several (I-065). Reads a signal, so labels rendered from it update once harnesses load.
 */
export function agentSectionLabel(): string {
  const list = harnesses.value;
  if (!list?.length) return "Agent";
  return list.length === 1 ? list[0]!.label : "Agents";
}

export const SECTION_INFO: Record<SettingsSection, { label: string; Icon: typeof Cpu }> = {
  general: { label: "General", Icon: Settings2 },
  models: { label: "Models", Icon: Cpu },
  appearance: { label: "Appearance", Icon: Palette },
  agent: {
    get label() {
      return agentSectionLabel();
    },
    Icon: SquareTerminal,
  },
  commands: { label: "Slash Commands", Icon: SlashSquare },
  prompts: { label: "Prompts", Icon: BookText },
  remote: { label: "Remote Access", Icon: Globe },
};

/** Sections that belong to the environment running the agents (I-123): they get an environment switcher. */
export const HOST_SECTIONS: readonly SettingsSection[] = ["models", "agent", "commands", "prompts"];

export interface SettingsGroup {
  title: string;
  sections: SettingsSection[];
}

/** Sidebar categories in order. Every section must appear in exactly one group. */
export const SETTINGS_GROUPS: SettingsGroup[] = [
  { title: "App", sections: ["general", "appearance", "remote"] },
  { title: "AI", sections: ["models", "agent", "commands", "prompts"] },
];
