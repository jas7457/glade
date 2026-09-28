/**
 * Settings screen (main pane). The section list lives in the sidebar (SettingsNav); this renders
 * the selected section at `/settings/:section`.
 */
import { useEffect } from "preact/hooks";
import { Navigate, useParams } from "react-router";
import { lastSettings, rememberSettings } from "@/app/lastSettings";
import { SETTINGS_SECTIONS, routes, type SettingsSection } from "@/app/routes";
import { Titlebar } from "@/ui";
import { HOST_SECTIONS, SECTION_INFO } from "./sections";
import { RemoteAccessSettings, SettingsEnvironmentSwitcher } from "@/features/environments";
import { hostEnvId } from "@/state/host-settings";
import { connectionFor, settingsEnvironmentId } from "@/state/env-registry";
import { GeneralSettings } from "./GeneralSettings";
import { ModelSettings } from "./ModelSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { AgentSettings } from "./AgentSettings";
import { CommandSettings } from "./CommandSettings";
import { PromptSettings } from "./PromptSettings";

const PANELS: Record<SettingsSection, () => preact.JSX.Element> = {
  general: GeneralSettings,
  models: ModelSettings,
  appearance: AppearanceSettings,
  agent: AgentSettings,
  commands: CommandSettings,
  prompts: PromptSettings,
  remote: RemoteAccessSettings,
};

export function isSettingsSection(value: string | undefined): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

export function SettingsView({ section }: { section: SettingsSection }) {
  const Panel = PANELS[section];
  const host = HOST_SECTIONS.includes(section);
  const envId = host ? (hostEnvId() ?? null) : null;
  // I-133: remember the page (and a host section's environment) so `/settings` reopens it.
  useEffect(() => rememberSettings(section, envId), [section, envId]);
  return (
    <div class="flex h-full min-h-0 flex-col">
      <Titlebar />
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto w-full max-w-[640px] px-8 pb-10">
          <h1 class="mb-5 text-[1.3rem] font-bold text-fg-strong">{SECTION_INFO[section].label}</h1>
          {host && <SettingsEnvironmentSwitcher />}
          {/* Keyed by environment so a switch reloads what the panel fetched (e.g. folder commands). */}
          <Panel key={envId ?? ""} />
        </div>
      </div>
    </div>
  );
}

/** Route element for `/settings/:section`. */
export function SettingsRoute() {
  const { section } = useParams();
  if (!isSettingsSection(section)) return <Navigate to={routes.settings("general")} replace />;
  return <SettingsView section={section} />;
}

/**
 * Route element for `/settings` without a section (I-133): opens the last section you had open
 * (General if none or it no longer exists) and, for a host section, the environment picked then.
 */
export function SettingsIndexRoute() {
  const last = lastSettings((id) => !!connectionFor(id));
  if (HOST_SECTIONS.includes(last.section)) settingsEnvironmentId.value = last.envId;
  return <Navigate to={routes.settings(last.section)} replace />;
}
