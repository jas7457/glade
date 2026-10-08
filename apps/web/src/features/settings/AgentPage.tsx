/**
 * One agent's page under Settings → Agents (`/settings/agent/<harnessId>`, I-198): its status and
 * Enable switch, its version with Update (`AgentVersionGroup`), then its own "Defaults" (model and
 * thinking for new chats, sub-agents, side questions) and "Models" (show/hide), listing only that
 * agent's models. Agents that choose their own model (`capabilities.models === false`) have no
 * model settings. Last, Advanced (I-201): a custom command for the agent (`AgentAdvancedGroup`).
 *
 * On another device (device switcher) the settings are view only, but Version's Check and Update
 * work (actions, like Local Models' Load/Unload), and so does the Models filter (I-207).
 */
import { FormGroup, FormRow } from "@glade/app-core/ui";
import { cn } from "@glade/app-core/lib/cn";
import { hostHarnesses, hostReadOnly } from "@glade/app-core/state/host-settings";
import type { AgentCatalogEntry } from "@glade/protocol";
import { AgentEnableSwitch, AgentStatus, agentDescription, setAgentEnabled } from "./AgentSettings";
import { AgentVersionGroup } from "./AgentVersion";
import { AgentAdvancedGroup } from "./AgentAdvanced";
import { AgentModelGroups } from "./ModelSettings";

export function AgentPage({ entry }: { entry: AgentCatalogEntry }) {
  const readOnly = hostReadOnly.value;
  const info = hostHarnesses.value?.find((h) => h.id === entry.id);
  const description = agentDescription(entry);
  const viewOnly = (children: preact.ComponentChildren) => (
    <fieldset disabled={readOnly} class={cn("min-w-0", readOnly && "pointer-events-none")}>
      {children}
    </fieldset>
  );
  return (
    <>
      {viewOnly(
        <FormGroup>
          <FormRow label={<AgentStatus entry={entry} />} description={description}>
            <AgentEnableSwitch entry={entry} readOnly={readOnly} onEnable={(on) => void setAgentEnabled(entry.id, on)} />
          </FormRow>
        </FormGroup>,
      )}

      <AgentVersionGroup harness={entry.id} />

      {info && info.capabilities.models !== false ? (
        // Disables its settings itself: the Models filter works on another device too (I-207).
        <AgentModelGroups harness={entry.id} readOnly={readOnly} />
      ) : (
        viewOnly(
          info ? (
            <FormGroup title="Models">
              <FormRow label={<span class="text-fg-muted">{info.label} chooses its own model.</span>} />
            </FormGroup>
          ) : (
            <FormGroup title="Models">
              <FormRow
                label={
                  <span class="text-fg-muted">
                    {entry.installed ? `Turn ${entry.label} on to see its models and defaults.` : `${entry.label} isn't installed on this device.`}
                  </span>
                }
              />
            </FormGroup>
          ),
        )
      )}

      <AgentAdvancedGroup entry={entry} />
    </>
  );
}
