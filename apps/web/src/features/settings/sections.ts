/** Settings section metadata (labels + icons) and the sidebar categories they're grouped in. */
import { Cpu, Palette, Settings2, SquareTerminal } from "lucide-preact";
import type { SettingsSection } from "@/app/routes";

export const SECTION_INFO: Record<SettingsSection, { label: string; Icon: typeof Cpu }> = {
  general: { label: "General", Icon: Settings2 },
  models: { label: "Models", Icon: Cpu },
  appearance: { label: "Appearance", Icon: Palette },
  agent: { label: "Agent (pi)", Icon: SquareTerminal },
};

export interface SettingsGroup {
  title: string;
  sections: SettingsSection[];
}

/** Sidebar categories in order. Every section must appear in exactly one group. */
export const SETTINGS_GROUPS: SettingsGroup[] = [
  { title: "App", sections: ["general", "appearance"] },
  { title: "AI", sections: ["models", "agent"] },
];
