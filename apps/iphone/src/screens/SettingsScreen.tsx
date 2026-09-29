/**
 * Settings on the iPhone (I-164, doc §4.4/§5.5): only the phone's own things. Devices (each paired
 * Mac with its status → DeviceScreen; Connect to a Device…), Appearance (theme, stored on the
 * phone) and About. Nothing about sharing this device: the iPhone runs no server.
 */
import { ChevronLeft, Laptop, Plus } from "lucide-preact";
import { useNavigate } from "react-router";
import { connectionFor } from "@glade/app-core/state/env-registry";
import { remoteStateOf, remoteStateText } from "@glade/app-core/state/remote-status";
import { savedEnvironments } from "@glade/app-core/state/saved-environments";
import { paths } from "~/app/routes";
import { phoneTheme, setPhoneTheme, type PhoneTheme } from "~/state/theme";
import { ListGroup, ListRow, NavBar, NavIconButton, Screen, ScreenBody } from "~/ui/phone";
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
                subtitle={remoteStateText(state, name)}
                chevron
                onClick={() => navigate(paths.device(env.id))}
              />
            );
          })}
          <ListRow icon={<Plus size={22} />} title="Connect to a Device…" tone="accent" onClick={() => navigate(paths.connect())} />
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
    </Screen>
  );
}
