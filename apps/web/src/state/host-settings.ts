/**
 * Host settings (I-123 §5.3): agent, model, harness, slash-command and prompt settings belong to
 * the environment that runs the agents. The Settings screen edits the environment picked in its
 * switcher (`settingsEnvironmentId`); these read and write that environment's shell. Look and
 * feel (Appearance, General) stays on the local/client settings.
 *
 * Drop-in names for the settings sections: `hostSettings.value` like `settings.value`,
 * `updateHostSettings(patch)` like `updateSettings(patch)`.
 */
import { computed } from "@preact/signals";
import type { DeepPartial, Settings } from "@glade/protocol";
import { updateSettings } from "./actions";
import { connectionFor, primaryEnvironmentId, settingsEnvironmentId } from "./env-registry";
import { defaultHarnessOf, harnessesOf, loadHarnesses } from "./harnesses";
import { envIdOf, loadModels, shellOf, sortedProjects, visibleModelsOf } from "./store";

/** The environment being edited, `undefined` for the local/primary one (or a disconnected pick). */
export function hostEnvId(): string | undefined {
  const id = settingsEnvironmentId.value;
  return id && connectionFor(id) ? id : undefined;
}

const hostShell = () => shellOf(hostEnvId());

export const hostSettings = computed(() => hostShell().settings.value);
export const hostModels = computed(() => hostShell().models.value);
export const hostVisibleModels = computed(() => visibleModelsOf(hostShell()));
export const hostHarnessDefaults = computed(() => hostShell().harnessDefaults.value);
export const hostHarnesses = computed(() => harnessesOf(hostEnvId()));
export const hostDefaultHarness = computed(() => defaultHarnessOf(hostEnvId()));
/** Projects of the edited environment (project-scoped prompts and commands). */
export const hostProjects = computed(() => {
  const env = hostEnvId() ?? primaryEnvironmentId();
  return sortedProjects.value.filter((p) => envIdOf(p) === env);
});

export function updateHostSettings(patch: DeepPartial<Settings>): Promise<boolean> {
  return updateSettings(patch, hostEnvId());
}

export function loadHostModels(refresh = false): Promise<void> {
  return loadModels(refresh, hostEnvId());
}

export function loadHostHarnesses(): Promise<void> {
  return loadHarnesses(hostEnvId());
}
