/**
 * Settings screen (main pane). The section list lives in the sidebar (SettingsNav); this renders
 * the selected section at `/settings/:section`.
 */
import { Navigate, useParams } from "react-router";
import { SETTINGS_SECTIONS, routes, type SettingsSection } from "@/app/routes";
import { Titlebar } from "@/ui";
import { SECTION_INFO } from "./sections";
import { GeneralSettings } from "./GeneralSettings";
import { ModelSettings } from "./ModelSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { AgentSettings } from "./AgentSettings";

const PANELS: Record<SettingsSection, () => preact.JSX.Element> = {
  general: GeneralSettings,
  models: ModelSettings,
  appearance: AppearanceSettings,
  agent: AgentSettings,
};

export function isSettingsSection(value: string | undefined): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

export function SettingsView({ section }: { section: SettingsSection }) {
  const Panel = PANELS[section];
  return (
    <div class="flex h-full min-h-0 flex-col">
      <Titlebar />
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto w-full max-w-[640px] px-8 pb-10">
          <h1 class="mb-5 text-[1.3rem] font-bold text-fg-strong">{SECTION_INFO[section].label}</h1>
          <Panel />
        </div>
      </div>
    </div>
  );
}

/** Route element for `/settings/:section`. */
export function SettingsRoute() {
  const { section } = useParams();
  if (!isSettingsSection(section)) return <Navigate to={routes.settings()} replace />;
  return <SettingsView section={section} />;
}
