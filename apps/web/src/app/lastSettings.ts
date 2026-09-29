/**
 * Settings reopens on the last page you had open (I-133). The settings screen remembers its
 * section per device (localStorage, like the last route in `lastRoute.ts`), and for the host
 * sections (Models, Agents, …) also the environment picked in its switcher. Opening Settings
 * without a section (`/settings`: ⌘,, the sidebar button, the palette, `/settings` in the
 * composer) goes back there; a link to a specific section always wins. A remembered section that
 * no longer exists (About, Appearance: folded into General by I-160/I-161) falls back to General;
 * a remembered environment that isn't connected falls back to this machine.
 */
import { SETTINGS_SECTIONS, type SettingsSection } from "@glade/app-core/app/routes";
import { readStored, writeStored } from "@glade/app-core/state/ui";

const KEY_LAST_SETTINGS = "glade.lastSettings";

export interface LastSettings {
  section: SettingsSection;
  /** Environment of a host section (null = this machine / not a host section). */
  envId: string | null;
}

const isSection = (value: unknown): value is SettingsSection => typeof value === "string" && (SETTINGS_SECTIONS as readonly string[]).includes(value);

/**
 * Where plain `/settings` opens, from the stored value: its section if it still exists (else
 * General), with its environment only while that environment is connected.
 */
export function resolveLastSettings(raw: string | null, hasEnvironment: (envId: string) => boolean = () => false): LastSettings {
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    /* garbage: fall back */
  }
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as { section?: unknown; envId?: unknown };
  if (!isSection(obj.section)) return { section: "general", envId: null };
  const envId = typeof obj.envId === "string" && hasEnvironment(obj.envId) ? obj.envId : null;
  return { section: obj.section, envId };
}

/** The remembered settings page (see `resolveLastSettings`). */
export function lastSettings(hasEnvironment?: (envId: string) => boolean): LastSettings {
  return resolveLastSettings(readStored(KEY_LAST_SETTINGS), hasEnvironment);
}

/** Remember the settings page in view (`envId` only for host sections; null = this machine). */
export function rememberSettings(section: SettingsSection, envId: string | null): void {
  writeStored(KEY_LAST_SETTINGS, JSON.stringify({ section, envId }));
}
