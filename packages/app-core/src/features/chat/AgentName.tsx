/**
 * A sub-agent's name as cards and bars show it (I-084, I-218, I-217): its icon (when its agent
 * definition has one) and fun name in its colour, the definition (or functional) name greyed
 * ("Brandon · scout"), and a small harness badge when it runs on another harness than its parent
 * chat. The caller sets `data-agent-color` on an ancestor (the `text-agent` colour).
 *
 *   <AgentName identity={identity} />
 *   <AgentName identity={identity} role={false} harness={false} />   // chips: icon + name only
 */
import { cn } from "@glade/app-core/lib/cn";
import { harnessName } from "@glade/app-core/state/harnesses";
import { AgentIconGlyph, Badge } from "@glade/app-core/ui";
import type { AgentIdentityView } from "./agent-identity";

export interface AgentNameProps {
  identity: AgentIdentityView;
  /** Show the greyed role/definition (default true). */
  role?: boolean;
  /** Show the harness badge when it differs from the parent's (default true). */
  harness?: boolean;
  /** Environment of the agent (for the harness's name). */
  envId?: string | null;
  /** Classes for the name (default `font-medium`). */
  nameClass?: string;
  iconSize?: number;
}

export function AgentName({ identity, role = true, harness = true, envId, nameClass = "font-medium", iconSize = 12 }: AgentNameProps) {
  const harnessLabel = harness && identity.harness ? harnessName(identity.harness, envId) : null;
  return (
    <>
      {identity.icon && <AgentIconGlyph icon={identity.icon} size={iconSize} class="text-agent" />}
      <span class={cn("shrink-0 text-agent", nameClass)}>{identity.displayName}</span>
      {role && identity.role && <span class="shrink-0 text-fg-subtle">· {identity.role}</span>}
      {harnessLabel && (
        <Badge title={`Runs on ${harnessLabel}`} class="shrink-0">
          {harnessLabel}
        </Badge>
      )}
    </>
  );
}

/** "Runs on Codex" when it runs on another harness than its parent, else null (tooltips). */
export function agentHarnessNote(identity: AgentIdentityView, envId?: string | null): string | null {
  return identity.harness ? `Runs on ${harnessName(identity.harness, envId)}` : null;
}
