/**
 * Settings screen (main pane). The section list lives in the sidebar (SettingsNav); this renders
 * the selected section at `/settings/:section`, or one agent's page at `/settings/agent/:harness`
 * (I-198; titled with the agent's name and a back button to Agents). The AI pages (host sections)
 * say which device they belong to; another device's are view only (I-155): the panel's controls
 * are disabled (a disabled fieldset) and a note says where to change them. Local Models and Agents
 * are the exceptions (I-196, I-198): Load/Unload and agent updates work on any Mac, so those panels
 * disable only their settings fields there.
 */
import { useEffect } from "preact/hooks";
import { Navigate, useNavigate, useParams } from "react-router";
import { lastSettings, rememberSettings } from "@/app/lastSettings";
import { SETTINGS_SECTIONS, routes, type SettingsSection } from "@glade/app-core/app/routes";
import { FormGroup, FormRow, IconButton, Titlebar } from "@glade/app-core/ui";
import { ACTION_SECTIONS, HOST_SECTIONS, SECTION_INFO } from "./sections";
import { ChevronLeft, Laptop } from "lucide-preact";
import { RemoteAccessSettings } from "@/features/environments";
import { hostDeviceName, hostEnvId, hostHarnesses, hostReadOnly } from "@glade/app-core/state/host-settings";
import { agentCatalogOf } from "@glade/app-core/state/agent-catalog";
import type { AgentCatalogEntry } from "@glade/protocol";
import { cn } from "@glade/app-core/lib/cn";
import { connectionFor, settingsEnvironmentId } from "@glade/app-core/state/env-registry";
import { GeneralSettings } from "./GeneralSettings";
import { AgentSettings, useHostCatalog } from "./AgentSettings";
import { AgentPage } from "./AgentPage";
import { CommandSettings } from "./CommandSettings";
import { PromptSettings } from "./PromptSettings";
import { LocalModelSettings } from "./LocalModelSettings";

const PANELS: Record<SettingsSection, () => preact.JSX.Element> = {
  general: GeneralSettings,
  agent: AgentSettings,
  commands: CommandSettings,
  prompts: PromptSettings,
  "local-models": LocalModelSettings,
  remote: RemoteAccessSettings,
};

export function isSettingsSection(value: string | undefined): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

export function SettingsView({ section, agent }: { section: SettingsSection; agent?: { id: string; label: string; page: preact.ComponentChildren } }) {
  const navigate = useNavigate();
  const Panel = PANELS[section];
  const host = HOST_SECTIONS.includes(section);
  const envId = host ? (hostEnvId() ?? null) : null;
  const viewOnly = host && hostReadOnly.value;
  // Local Models (I-196) and Agents (I-198) stay usable on another Mac: their panels disable only
  // their settings fields.
  const readOnly = viewOnly && !ACTION_SECTIONS.includes(section);
  const label = agent?.label ?? SECTION_INFO[section].label;
  // I-133: remember the page (and a host section's environment) so `/settings` reopens it.
  useEffect(() => rememberSettings(section, envId, agent?.id), [section, envId, agent?.id]);
  return (
    <div class="flex h-full min-h-0 flex-col">
      <Titlebar />
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto w-full max-w-[640px] px-8 pb-10">
          <div class={cn("flex items-center gap-1", host ? "mb-1" : "mb-5", agent && "-ml-8")}>
            {agent && (
              <IconButton label={SECTION_INFO[section].label} class="w-7 shrink-0" onClick={() => navigate(routes.settings(section))}>
                <ChevronLeft />
              </IconButton>
            )}
            <h1 class="text-[1.3rem] font-bold text-fg-strong">{label}</h1>
          </div>
          {host && (
            <p class="mb-5 flex items-center gap-1.5 text-fg-muted select-none" aria-label="Device">
              <Laptop size={13} class="shrink-0" />
              {hostDeviceName.value}
            </p>
          )}
          {viewOnly && (readOnly || section === "agent") && (
            <div role="note">
              <FormGroup class="mb-5">
                <FormRow
                  label={
                    <span class="text-fg-muted">
                      {readOnly
                        ? `View only. Change this on ${hostDeviceName.value}.`
                        : `View only. Change these settings on ${hostDeviceName.value}; checking for and installing agent updates works from here.`}
                    </span>
                  }
                />
              </FormGroup>
            </div>
          )}
          {/* Keyed by environment so a switch reloads what the panel fetched (e.g. folder commands). */}
          <fieldset disabled={readOnly} class={cn("min-w-0", readOnly && "pointer-events-none")} aria-label={readOnly ? `${label} (view only)` : undefined}>
            {agent ? <div key={`${envId ?? ""}:${agent.id}`}>{agent.page}</div> : <Panel key={envId ?? ""} />}
          </fieldset>
        </div>
      </div>
    </div>
  );
}

/**
 * Route element for `/settings/:section`. Unknown and removed sections (`about`, `appearance`:
 * I-160/I-161) open General; `models` (folded into Agents, I-198) opens Agents.
 */
export function SettingsRoute() {
  const { section } = useParams();
  if (section === "models") return <Navigate to={routes.settings("agent")} replace />;
  if (!isSettingsSection(section)) return <Navigate to={routes.settings("general")} replace />;
  return <SettingsView section={section} />;
}

/**
 * Route element for `/settings/agent/:harness` (I-198): that agent's page on the device picked in
 * the switcher. An agent the device doesn't know (once its catalog loaded) opens Agents.
 */
export function SettingsAgentRoute() {
  const { harness = "" } = useParams();
  const catalog = useHostCatalog();
  const loaded = !!agentCatalogOf(hostEnvId())?.length;
  const entry = catalog.find((e) => e.id === harness) ?? (loaded ? null : unknownEntry(harness, hostHarnesses.value?.find((h) => h.id === harness)?.label));
  if (!entry) return <Navigate to={routes.settings("agent")} replace />;
  return <SettingsView section="agent" agent={{ id: entry.id, label: entry.label, page: <AgentPage entry={entry} /> }} />;
}

/** A placeholder entry while the catalog loads (or from an older server). */
function unknownEntry(id: string, label?: string): AgentCatalogEntry {
  return { id, label: label ?? id, kind: "builtin", command: null, lookedFor: [], installed: true, enabled: true, offered: !!label, isDefault: false };
}

/**
 * Route element for `/settings` without a section (I-133): opens the last section you had open
 * (General if none or it no longer exists; an agent's page too) and, for a host section, the
 * environment picked then.
 */
export function SettingsIndexRoute() {
  const last = lastSettings((id) => !!connectionFor(id));
  if (HOST_SECTIONS.includes(last.section)) settingsEnvironmentId.value = last.envId;
  return <Navigate to={last.agent ? routes.settingsAgent(last.agent) : routes.settings(last.section)} replace />;
}
