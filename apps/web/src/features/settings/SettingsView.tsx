/**
 * Settings screen (main pane). The section list lives in the sidebar (SettingsNav); this renders
 * the selected section at `/settings/:section`. The AI pages (host sections) say which device
 * they belong to; another device's are view only (I-155): the panel's controls are disabled
 * (a disabled fieldset) and a note says where to change them.
 */
import { useEffect } from "preact/hooks";
import { Navigate, useParams } from "react-router";
import { lastSettings, rememberSettings } from "@/app/lastSettings";
import { SETTINGS_SECTIONS, routes, type SettingsSection } from "@/app/routes";
import { FormGroup, FormRow, Titlebar } from "@/ui";
import { HOST_SECTIONS, SECTION_INFO } from "./sections";
import { Laptop } from "lucide-preact";
import { RemoteAccessSettings } from "@/features/environments";
import { hostDeviceName, hostEnvId, hostReadOnly } from "@/state/host-settings";
import { cn } from "@/lib/cn";
import { connectionFor, settingsEnvironmentId } from "@/state/env-registry";
import { GeneralSettings } from "./GeneralSettings";
import { ModelSettings } from "./ModelSettings";
import { AgentSettings } from "./AgentSettings";
import { CommandSettings } from "./CommandSettings";
import { PromptSettings } from "./PromptSettings";

const PANELS: Record<SettingsSection, () => preact.JSX.Element> = {
  general: GeneralSettings,
  models: ModelSettings,
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
  const readOnly = host && hostReadOnly.value;
  // I-133: remember the page (and a host section's environment) so `/settings` reopens it.
  useEffect(() => rememberSettings(section, envId), [section, envId]);
  return (
    <div class="flex h-full min-h-0 flex-col">
      <Titlebar />
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto w-full max-w-[640px] px-8 pb-10">
          <h1 class={cn("text-[1.3rem] font-bold text-fg-strong", host ? "mb-1" : "mb-5")}>{SECTION_INFO[section].label}</h1>
          {host && (
            <p class="mb-5 flex items-center gap-1.5 text-fg-muted select-none" aria-label="Device">
              <Laptop size={13} class="shrink-0" />
              {hostDeviceName.value}
            </p>
          )}
          {readOnly && (
            <div role="note">
              <FormGroup class="mb-5">
                <FormRow label={<span class="text-fg-muted">View only. Change this on {hostDeviceName.value}.</span>} />
              </FormGroup>
            </div>
          )}
          {/* Keyed by environment so a switch reloads what the panel fetched (e.g. folder commands). */}
          <fieldset disabled={readOnly} class={cn("min-w-0", readOnly && "pointer-events-none")} aria-label={readOnly ? `${SECTION_INFO[section].label} (view only)` : undefined}>
            <Panel key={envId ?? ""} />
          </fieldset>
        </div>
      </div>
    </div>
  );
}

/** Route element for `/settings/:section`. Unknown and removed sections (`about`, `appearance`: I-160/I-161) open General. */
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
