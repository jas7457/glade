/**
 * Sidebar rows for remote environments that are down (I-132): their projects and chats are
 * hidden meanwhile, so the computer itself stays listed, greyed, with its status as the tooltip and
 * the globe popover (Retry / Pair Again…). Clicking opens Settings → Remote Access.
 */
import { useNavigate } from "react-router";
import { Monitor } from "lucide-preact";
import { routes } from "@glade/app-core/app/routes";
import { connectionFor } from "@glade/app-core/state/env-registry";
import { downEnvironments, remoteStateOf, remoteStateShort, remoteStateText } from "@glade/app-core/state/remote-status";
import { SidebarItem } from "@glade/app-core/ui";
import { RemoteMarker } from "./RemoteMarker";

export function DownEnvironmentRows() {
  const navigate = useNavigate();
  const down = [...downEnvironments.value];
  if (down.length === 0) return null;
  return (
    <>
      {down.map((id) => {
        const conn = connectionFor(id);
        if (!conn) return null;
        const name = conn.name.value;
        const state = remoteStateOf(id);
        return (
          <SidebarItem
            key={id}
            data-down-environment={id}
            class="opacity-60"
            icon={<Monitor />}
            label={name}
            title={remoteStateText(state, name)}
            badge={<RemoteMarker envId={id} />}
            trailing={<span class="text-[0.85rem] text-fg-muted">{remoteStateShort(state)}</span>}
            onSelect={() => navigate(routes.settings("remote"))}
          />
        );
      })}
    </>
  );
}
