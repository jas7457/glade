/** Settings section metadata (labels + icons) in sidebar order. */
import { Archive, Cpu, Palette, Settings2, SquareTerminal } from "lucide-preact";
import type { SettingsSection } from "@/app/routes";

export const SECTION_INFO: Record<SettingsSection, { label: string; Icon: typeof Archive }> = {
  general: { label: "General", Icon: Settings2 },
  models: { label: "Models", Icon: Cpu },
  appearance: { label: "Appearance", Icon: Palette },
  agent: { label: "Agent", Icon: SquareTerminal },
  archived: { label: "Archived Chats", Icon: Archive },
};
