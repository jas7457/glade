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
import type { AgentModelSettings, DeepPartial, HarnessDefaults, ModelInfo, QuickTasksModel, Settings } from "@glade/protocol";
import { updateSettings } from "./actions";
import { connectionFor, environmentLabel, isLocalEnvironment, primaryEnvironmentId, settingsEnvironmentId } from "./env-registry";
import { defaultHarnessOf, harnessesOf, loadHarnesses } from "./harnesses";
import { agentDefaultsOf, agentModelsOf, envIdOf, loadModels, modelsForHarness, quickTasksModelOf, shellOf, sortedProjects, visibleModelsOf } from "./store";

/** The environment being edited, `undefined` for the local/primary one (or a disconnected pick). */
export function hostEnvId(): string | undefined {
  const id = settingsEnvironmentId.value;
  return id && connectionFor(id) ? id : undefined;
}

const hostShell = () => shellOf(hostEnvId());

/**
 * Another device's settings are view only (I-155): you change them on that device. True when
 * the edited environment isn't this machine (the host refuses the writes anyway, 403).
 */
export const hostReadOnly = computed(() => !isLocalEnvironment(hostEnvId()));
/** The edited environment's name for headers ("This Mac", "MacBook Air"). */
export const hostDeviceName = computed(() => environmentLabel(hostEnvId()));

export const hostSettings = computed(() => hostShell().settings.value);
export const hostModels = computed(() => hostShell().models.value);
export const hostVisibleModels = computed(() => visibleModelsOf(hostShell()));
export const hostHarnessDefaults = computed(() => hostShell().harnessDefaults.value);
export const hostHarnesses = computed(() => harnessesOf(hostEnvId()));
export const hostDefaultHarness = computed(() => defaultHarnessOf(hostEnvId()));
/** The Glade-wide quick-tasks model of the edited environment (`null` = automatic; I-198). */
export const hostQuickTasks = computed<QuickTasksModel | null>(() => quickTasksModelOf(hostShell()));

/** Agent `harness`'s model settings on the edited environment (I-198). */
export function hostAgentModels(harness: string): AgentModelSettings {
  return agentModelsOf(hostShell(), harness);
}

/** Every model agent `harness` lists on the edited environment (hidden ones too). */
export function hostModelsFor(harness: string): ModelInfo[] {
  return modelsForHarness(hostShell().models.value, harness);
}

/** Agent `harness`'s models shown in pickers on the edited environment (its hidden ones filtered out). */
export function hostVisibleModelsFor(harness: string): ModelInfo[] {
  return visibleModelsOf(hostShell(), harness);
}

/** Agent `harness`'s own default model/thinking on the edited environment (what "Default" means). */
export function hostAgentDefaults(harness: string): HarnessDefaults | null {
  return agentDefaultsOf(harness, hostEnvId());
}

/** Change agent `harness`'s model settings on the edited environment (I-198). */
export function updateHostAgentModels(harness: string, patch: Partial<AgentModelSettings>): Promise<boolean> {
  return updateHostSettings({ models: { agents: { [harness]: patch } } });
}

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
