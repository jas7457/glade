/**
 * Which environment the host sections of Settings edit (I-123 §5.3: agents, models, slash
 * commands and prompts belong to the machine that runs the agents). Only shown when more than
 * one environment is connected.
 */
import { connections, primaryEnvironmentId, settingsEnvironmentId, THIS_MACHINE_LABEL } from "@/state/env-registry";
import { hostEnvId } from "@/state/host-settings";
import { FormGroup, FormRow, Select } from "@/ui";

export function SettingsEnvironmentSwitcher() {
  const list = connections.value;
  if (list.length < 2) return null;
  const current = hostEnvId() ?? primaryEnvironmentId();
  return (
    <FormGroup class="mb-5" footer="These settings belong to the environment that runs the agents.">
      <FormRow label="Environment">
        <Select
          aria-label="Environment"
          value={current}
          onChange={(id) => {
            settingsEnvironmentId.value = id === primaryEnvironmentId() ? null : id;
          }}
          options={list.map((c) => ({ value: c.id, label: c.isLocal ? THIS_MACHINE_LABEL : c.name.value, detail: c.isLocal ? undefined : c.status.value === "live" ? "remote" : c.status.value }))}
        />
      </FormRow>
    </FormGroup>
  );
}
