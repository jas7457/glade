/**
 * Home (I-164): the chats across all connected Macs. Until the chat list lands (step 4) it lists
 * the connected devices and their status.
 */
import { Laptop, Plus, Settings } from "lucide-preact";
import { useNavigate } from "react-router";
import { remoteStateOf, remoteStateShort } from "@/state/remote-status";
import { connections } from "@/state/env-registry";
import { savedEnvironments } from "@/state/saved-environments";
import { paths } from "~/app/routes";
import { ListGroup, ListRow, NavBar, NavIconButton, Screen, ScreenBody } from "~/ui/phone";

export function HomeScreen() {
  const navigate = useNavigate();
  const byId = new Map(connections.value.map((c) => [c.id, c]));
  return (
    <Screen>
      <NavBar
        large
        title="Chats"
        left={
          <NavIconButton label="Settings" onClick={() => navigate(paths.settings())}>
            <Settings size={22} />
          </NavIconButton>
        }
        right={
          <NavIconButton label="Connect to a Device" onClick={() => navigate(paths.connect())}>
            <Plus size={24} />
          </NavIconButton>
        }
      />
      <ScreenBody>
        <ListGroup header="Devices">
          {savedEnvironments.value.map((env) => {
            const c = byId.get(env.id);
            return <ListRow key={env.id} icon={<Laptop size={20} />} title={c?.name.value ?? env.alias ?? env.name} detail={remoteStateShort(remoteStateOf(env.id))} />;
          })}
        </ListGroup>
      </ScreenBody>
    </Screen>
  );
}
