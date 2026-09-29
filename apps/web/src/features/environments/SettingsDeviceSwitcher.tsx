/**
 * "Settings for [This Mac ▾]" (I-155): one device switcher at the top of the AI group in the
 * Settings sidebar. The AI pages (Models, Agents, Slash Commands, Prompts) belong to the device
 * that runs the agents (I-123 §5.3); this picks which device's they show. Another device's are
 * view only (you change them on that device). Shown whenever another device is connected.
 */
import { connections, primaryEnvironmentId, settingsEnvironmentId, THIS_MACHINE_LABEL } from "@/state/env-registry";
import { hostEnvId } from "@/state/host-settings";
import { Select } from "@/ui";
import { remoteStateOf, remoteStateShort } from "@/state/remote-status";

export function SettingsDeviceSwitcher() {
  const list = connections.value;
  if (list.length < 2) return null;
  const current = hostEnvId() ?? primaryEnvironmentId();
  return (
    <div class="flex min-w-0 items-center gap-1.5 px-2 pb-1.5 text-[0.92rem] text-fg-muted select-none">
      <span class="shrink-0">Settings for</span>
      <Select
        aria-label="Settings for device"
        size="sm"
        class="min-w-0"
        value={current}
        onChange={(id) => {
          settingsEnvironmentId.value = id === primaryEnvironmentId() ? null : id;
        }}
        options={list.map((c) => ({ value: c.id, label: c.isLocal ? THIS_MACHINE_LABEL : c.name.value, detail: c.isLocal ? undefined : remoteStateShort(remoteStateOf(c.id)) }))}
      />
    </div>
  );
}
