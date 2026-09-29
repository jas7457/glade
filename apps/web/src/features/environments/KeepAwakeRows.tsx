/**
 * Settings → Remote Access, while this device is shared (I-147): "Keep this device awake while
 * it's shared" (on AC power, default on) and "Also on battery power" (default off), with the live
 * "Keeping this device awake: …" status and the closed-lid hint. `Settings.power` on this Mac's
 * server; only the Mac app holds the assertion.
 */
import { useEffect } from "preact/hooks";
import { defaultSettings } from "@glade/protocol";
import { FormRow, Switch } from "@/ui";
import { settings } from "@/state/store";
import { updateSettings } from "@/state/actions";
import { LID_HINT, powerStatus, powerStatusText, watchPower } from "@/state/power";

export function KeepAwakeRows() {
  useEffect(() => watchPower(), []);
  const power = settings.value.power ?? defaultSettings().power;
  const status = powerStatusText(powerStatus.value);
  return (
    <>
      <FormRow
        label="Keep this device awake while it's shared"
        description={`While another device is connected and this Mac is on power, so it stays reachable. ${LID_HINT}`}
        htmlFor="awake-shared"
      >
        <Switch id="awake-shared" checked={power.whileShared} onCheckedChange={(whileShared) => void updateSettings({ power: { whileShared } })} />
      </FormRow>
      {power.whileShared && (
        <FormRow label="Also on battery power" description="Uses more battery while a device stays connected." htmlFor="awake-battery">
          <Switch
            id="awake-battery"
            checked={power.whileSharedOnBattery}
            onCheckedChange={(whileSharedOnBattery) => void updateSettings({ power: { whileSharedOnBattery } })}
          />
        </FormRow>
      )}
      {status && <FormRow label={<span role="status" class="text-fg-muted">{status}</span>} />}
    </>
  );
}
