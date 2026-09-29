/** Settings section metadata (labels + icons) and the sidebar categories they're grouped in. */
import { BookText, Cpu, Globe, Settings2, SlashSquare, SquareTerminal } from "lucide-preact";
import type { SettingsSection } from "@/app/routes";

export const SECTION_INFO: Record<SettingsSection, { label: string; Icon: typeof Cpu }> = {
  general: { label: "General", Icon: Settings2 },
  models: { label: "Models", Icon: Cpu },
  // Always "Agents" (I-155): the page lists every agent the device can run.
  agent: { label: "Agents", Icon: SquareTerminal },
  commands: { label: "Slash Commands", Icon: SlashSquare },
  prompts: { label: "Prompts", Icon: BookText },
  remote: { label: "Remote Access", Icon: Globe },
};

/**
 * Sections that belong to the environment running the agents (I-123): the AI group. The device
 * switcher at the top of that group (I-155) picks whose settings they show; another device's are
 * view only.
 */
export const HOST_SECTIONS: readonly SettingsSection[] = ["agent", "models", "commands", "prompts"];

export interface SettingsGroup {
  title: string;
  sections: SettingsSection[];
}

/** Sidebar categories in order. Every section must appear in exactly one group. */
export const SETTINGS_GROUPS: SettingsGroup[] = [
  { title: "App", sections: ["general", "remote"] },
  { title: "AI", sections: ["agent", "models", "commands", "prompts"] },
];
