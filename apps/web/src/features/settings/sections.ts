/** Settings section metadata (labels + icons) and the sidebar categories they're grouped in. */
import { BookText, Cpu, Globe, HardDrive, Settings2, SlashSquare, SquareTerminal } from "lucide-preact";
import type { SettingsSection } from "@glade/app-core/app/routes";

export const SECTION_INFO: Record<SettingsSection, { label: string; Icon: typeof Cpu }> = {
  general: { label: "General", Icon: Settings2 },
  models: { label: "Models", Icon: Cpu },
  // Always "Agents" (I-155): the page lists every agent the device can run.
  agent: { label: "Agents", Icon: SquareTerminal },
  commands: { label: "Slash Commands", Icon: SlashSquare },
  prompts: { label: "Prompts", Icon: BookText },
  // Load/unload models in the Mac's llama-server (I-196).
  "local-models": { label: "Local Models", Icon: HardDrive },
  remote: { label: "Remote Access", Icon: Globe },
};

/**
 * Sections that belong to the environment running the agents (I-123): the AI group. The device
 * switcher at the top of that group (I-155) picks whose settings they show; another device's are
 * view only, except Local Models' Load/Unload (actions, not settings; see {@link ACTION_SECTIONS}).
 */
export const HOST_SECTIONS: readonly SettingsSection[] = ["agent", "models", "local-models", "commands", "prompts"];

/**
 * Host sections whose panel works on another device too (I-196: loading a model on another Mac is
 * an action); the panel itself makes its settings fields view only there.
 */
export const ACTION_SECTIONS: readonly SettingsSection[] = ["local-models"];

export interface SettingsGroup {
  title: string;
  sections: SettingsSection[];
}

/** Sidebar categories in order. Every section must appear in exactly one group. */
export const SETTINGS_GROUPS: SettingsGroup[] = [
  { title: "App", sections: ["general", "remote"] },
  { title: "AI", sections: ["agent", "models", "local-models", "commands", "prompts"] },
];
