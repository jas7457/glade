/**
 * Settings → General, the Mac parts (I-147/I-150):
 * - `KeepAwakeSettings`: "Keep this device awake while a chat is working" (`Settings.power`, on this
 *   Mac's server) with the live "Keeping this device awake: …" status (`state/power.ts`).
 * - `DesktopAppSettings` (Mac app only): Show in Dock, Open at login, "⌘Q keeps Glade in the menu
 *   bar". These are the app's own preferences (`lib/desktop.ts` → src-tauri `prefs.rs` /
 *   `login_item.rs`), not server settings.
 */
import { useEffect, useState } from "preact/hooks";
import { defaultSettings } from "@glade/protocol";
import { FormGroup, FormRow, Switch } from "@glade/app-core/ui";
import { settings } from "@glade/app-core/state/store";
import { updateSettings } from "@glade/app-core/state/actions";
import { LID_HINT, powerStatus, powerStatusText, watchPower } from "@/state/power";
import { getDesktopPrefs, getLoginItem, setDesktopPrefs, setLoginItem, type DesktopPrefs, type LoginItemStatus } from "@glade/app-core/lib/desktop";

export function KeepAwakeSettings() {
  useEffect(() => watchPower(), []);
  const power = settings.value.power ?? defaultSettings().power;
  const status = powerStatusText(powerStatus.value);
  return (
    <FormGroup title="Power" footer={LID_HINT}>
      <FormRow label="Keep this device awake while a chat is working" description="So replies aren't cut off when this device would go to sleep. The display can still turn off." htmlFor="awake-working">
        <Switch id="awake-working" checked={power.whileWorking} onCheckedChange={(whileWorking) => void updateSettings({ power: { whileWorking } })} />
      </FormRow>
      {status && <FormRow label={<span role="status" class="text-fg-muted">{status}</span>} />}
    </FormGroup>
  );
}

const LOGIN_HINT: Partial<Record<LoginItemStatus, string>> = {
  "requires-approval": "Allow Glade in System Settings › General › Login Items.",
  unavailable: "Not available in this build of Glade.",
};

export function DesktopAppSettings() {
  const [prefs, setPrefs] = useState<DesktopPrefs | null>(null);
  const [login, setLogin] = useState<LoginItemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void getDesktopPrefs().then(setPrefs, () => {});
    void getLoginItem().then(setLogin, () => setLogin("unavailable"));
  }, []);

  const change = async (patch: Partial<Pick<DesktopPrefs, "showInDock" | "quitToMenuBar">>) => {
    if (prefs) setPrefs({ ...prefs, ...patch });
    const next = await setDesktopPrefs(patch).catch(() => null);
    if (next) setPrefs(next);
  };
  const changeLogin = async (on: boolean) => {
    setError(null);
    try {
      setLogin(await setLoginItem(on));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      void getLoginItem().then(setLogin, () => {});
    }
  };

  return (
    <FormGroup title="Glade app">
      <FormRow label="Show in Dock" description="When off, Glade lives only in the menu bar, also while its window is open." htmlFor="show-in-dock">
        <Switch id="show-in-dock" checked={prefs?.showInDock ?? true} disabled={!prefs} onCheckedChange={(showInDock) => void change({ showInDock })} />
      </FormRow>
      <FormRow label="Open at login" description={error ? <span class="text-danger">{error}</span> : login ? LOGIN_HINT[login] : undefined} htmlFor="open-at-login">
        <Switch
          id="open-at-login"
          checked={login === "enabled" || login === "requires-approval"}
          disabled={!login || login === "unavailable"}
          onCheckedChange={(on) => void changeLogin(on)}
        />
      </FormRow>
      <FormRow
        label="⌘Q keeps Glade in the menu bar"
        description="Chats, sharing and notifications keep running. To stop everything, choose Quit Glade Completely (⌥⌘Q or the menu bar icon)."
        htmlFor="quit-to-menu-bar"
      >
        <Switch id="quit-to-menu-bar" checked={prefs?.quitToMenuBar ?? true} disabled={!prefs} onCheckedChange={(quitToMenuBar) => void change({ quitToMenuBar })} />
      </FormRow>
    </FormGroup>
  );
}
