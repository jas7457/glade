/**
 * Settings → Local Models (I-196): the shared Local Models panel for the Mac picked in the device
 * switcher (Load/Unload work on another Mac too) plus the model server's address
 * (`Settings.localModels.url`), which like every setting can only be changed on its own Mac.
 */
import { FormGroup, FormRow } from "@glade/app-core/ui";
import { LocalModelsPanel } from "@glade/app-core/features/local-models/LocalModelsPanel";
import { hostDeviceName, hostEnvId, hostReadOnly, hostSettings, updateHostSettings } from "@glade/app-core/state/host-settings";
import { defaultSettings } from "@glade/protocol";
import { refreshLocalModels } from "@glade/app-core/state/local-models";
import { CommitField } from "./CommitField";

const DEFAULT_URL = defaultSettings().localModels.url;

/** An http(s) URL, or an error message. */
export function validateServerUrl(value: string): string | null {
  const v = value.trim();
  if (!v) return null; // empty: back to the default
  try {
    const url = new URL(v);
    return url.protocol === "http:" || url.protocol === "https:" ? null : "Use an http:// or https:// address";
  } catch {
    return "Not a valid address";
  }
}

/** Save the address, then ask the (new) model server right away. */
async function saveUrl(value: string): Promise<void> {
  const env = hostEnvId();
  if (await updateHostSettings({ localModels: { url: value.trim() || DEFAULT_URL } })) await refreshLocalModels(env);
}

export function LocalModelSettings() {
  const readOnly = hostReadOnly.value;
  const url = hostSettings.value.localModels?.url ?? DEFAULT_URL;
  return (
    <LocalModelsPanel
      envId={hostEnvId()}
      urlHint={(current) => `Glade looks for it at ${current}${readOnly ? "" : " (Server URL below)"}.`}
      footer={
        <FormGroup
          title="Model Server"
          footer={readOnly ? `View only. Change this on ${hostDeviceName.value}.` : "llama-server on this Mac. Glade talks to it here; it doesn't need to be reachable from other devices."}
        >
          <FormRow label="Server URL" htmlFor="local-models-url">
            <CommitField
              id="local-models-url"
              class="w-[15rem]"
              mono
              disabled={readOnly}
              value={url}
              placeholder={DEFAULT_URL}
              validate={validateServerUrl}
              onCommit={(v) => void saveUrl(v)}
            />
          </FormRow>
        </FormGroup>
      }
    />
  );
}
