/**
 * Settings on the iPhone (I-164, doc §4.4/§5.5): only the phone's own things. Devices (each paired
 * Mac with its status → DeviceScreen; Connect to a Device…), This iPhone (its name on your Macs,
 * I-171), Voice (conversation mode, I-180), Appearance (theme, stored on the phone) and About. Nothing about sharing this device: the iPhone runs no server.
 */
import { useSignal } from "@preact/signals";
import { AudioLines, ChevronLeft, Laptop, Plus } from "lucide-preact";
import { useNavigate } from "react-router";
import { connectionFor } from "@glade/app-core/state/env-registry";
import { remoteStateOf } from "@glade/app-core/state/remote-status";
import { savedEnvironments } from "@glade/app-core/state/saved-environments";
import { paths } from "~/app/routes";
import { macStatusShort } from "~/lib/mac-status";
import { IPHONE_DEVICE_NAME, MAX_PHONE_NAME, phoneName, setPhoneName } from "~/state/connect";
import { phoneTheme, setPhoneTheme, type PhoneTheme } from "~/state/theme";
import { ListGroup, ListRow, NavBar, NavIconButton, PhoneButton, PhoneInput, Screen, ScreenBody, Sheet } from "~/ui/phone";
import { CheckRow } from "~/ui/phone-extra";
import pkg from "../../package.json";

const THEMES: Array<{ id: PhoneTheme; label: string }> = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

export const APP_VERSION: string = pkg.version;

export function SettingsScreen() {
  const navigate = useNavigate();
  const renaming = useSignal(false);
  const draft = useSignal("");
  const saveName = () => {
    setPhoneName(draft.value);
    renaming.value = false;
  };
  return (
    <Screen grouped>
      <NavBar
        title="Settings"
        left={
          <NavIconButton label="Back" onClick={() => navigate(paths.home())}>
            <ChevronLeft size={26} />
          </NavIconButton>
        }
      />
      <ScreenBody class="pt-2">
        <ListGroup header="Devices" footer="The Macs this iPhone uses. Each Mac shares itself from Glade → Settings → Remote Access.">
          {savedEnvironments.value.map((env) => {
            const name = connectionFor(env.id)?.name.value ?? env.alias ?? env.name;
            const state = remoteStateOf(env.id);
            return (
              <ListRow
                key={env.id}
                icon={<Laptop size={22} class="text-fg-muted" />}
                title={name}
                subtitle={macStatusShort(state)}
                chevron
                onClick={() => navigate(paths.device(env.id))}
              />
            );
          })}
          <ListRow icon={<Plus size={22} />} title="Connect to a Device…" tone="accent" onClick={() => navigate(paths.connect())} />
        </ListGroup>

        <ListGroup header="This iPhone" footer="Your Macs show this name in Glade → Settings → Remote Access.">
          <ListRow
            title="Name"
            detail={<span data-testid="phone-name">{phoneName.value}</span>}
            chevron
            onClick={() => {
              draft.value = phoneName.value;
              renaming.value = true;
            }}
          />
        </ListGroup>

        <ListGroup header="Voice Mode" footer="Talk with your agents hands-free: tap the waveform next to Send.">
          <ListRow icon={<AudioLines size={22} class="text-fg-muted" />} title="Voice" chevron onClick={() => navigate(paths.voiceSettings())} />
        </ListGroup>

        <ListGroup header="Appearance">
          {THEMES.map((t) => (
            <CheckRow key={t.id} title={t.label} checked={phoneTheme.value === t.id} onClick={() => setPhoneTheme(t.id)} />
          ))}
        </ListGroup>

        <ListGroup header="About">
          <ListRow title="Glade for iPhone" detail={`Version ${APP_VERSION}`} />
        </ListGroup>
      </ScreenBody>

      <Sheet
        open={renaming.value}
        onClose={() => (renaming.value = false)}
        title="This iPhone's Name"
        action={
          <PhoneButton kind="plain" onClick={saveName}>
            Save
          </PhoneButton>
        }
      >
        <form
          class="px-4 pt-1 pb-3"
          onSubmit={(e) => {
            e.preventDefault();
            saveName();
          }}
        >
          <PhoneInput
            aria-label="This iPhone's name"
            placeholder={IPHONE_DEVICE_NAME}
            maxLength={MAX_PHONE_NAME}
            value={draft.value}
            autoFocus
            onInput={(e) => (draft.value = (e.currentTarget as HTMLInputElement).value)}
          />
          <p class="px-4 pt-2 text-[13px] text-fg-muted">Every Mac this iPhone uses shows this name. Macs that aren't connected get it next time.</p>
        </form>
      </Sheet>
    </Screen>
  );
}
