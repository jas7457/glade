/**
 * Agent icons (I-218): the one place the `AGENT_ICONS` names of an agent definition map to lucide
 * icons. Rendered on sub-agent cards, chips and tabs (in the agent's colour where the caller sets
 * `data-agent-color` + `text-agent`) and in Settings → Sub-agents' icon picker.
 *
 *   <AgentIconGlyph icon="search" size={12} />      // nothing for an unknown/absent icon
 *   <AgentIconGlyph icon={null} fallback />         // a neutral bot glyph instead
 */
import type { LucideIcon } from "lucide-preact";
import { Book, Bot, Bug, Compass, Eye, FlaskConical, Hammer, Pen, Rocket, Search, Shield, Sparkles, Wrench } from "lucide-preact";
import { AGENT_ICONS, type AgentIcon } from "@glade/protocol";
import { cn } from "@glade/app-core/lib/cn";

export const AGENT_ICON_COMPONENTS: Record<AgentIcon, LucideIcon> = {
  search: Search,
  hammer: Hammer,
  shield: Shield,
  book: Book,
  flask: FlaskConical,
  compass: Compass,
  bug: Bug,
  pen: Pen,
  eye: Eye,
  wrench: Wrench,
  rocket: Rocket,
  sparkles: Sparkles,
};

/** A known icon name, else null (older/unknown values render nothing). */
export function agentIconOf(name: string | null | undefined): AgentIcon | null {
  return (AGENT_ICONS as readonly string[]).includes(name ?? "") ? (name as AgentIcon) : null;
}

export interface AgentIconGlyphProps {
  icon: string | null | undefined;
  size?: number;
  /** Show a neutral bot glyph when there's no icon (Settings lists). */
  fallback?: boolean;
  class?: string;
}

export function AgentIconGlyph({ icon, size = 12, fallback = false, class: className }: AgentIconGlyphProps) {
  const key = agentIconOf(icon);
  const Icon = key ? AGENT_ICON_COMPONENTS[key] : fallback ? Bot : null;
  if (!Icon) return null;
  return <Icon size={size} aria-hidden="true" data-agent-icon={key ?? "default"} class={cn("shrink-0", className)} />;
}
