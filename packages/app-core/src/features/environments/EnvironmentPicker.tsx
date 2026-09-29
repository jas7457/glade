/**
 * Context bar: which environment a new chat without a project runs on (I-123 §5.3). Comes
 * first (then agent, model and thinking, all filtered to it). Only shown when more than one
 * environment is connected, i.e. remote access is on and a remote one is known. Picking one opens
 * that environment's new-chat screen (`/` or `/e/:envId`).
 */
import { useNavigate } from "react-router";
import { ChevronDown, Globe, Laptop } from "lucide-preact";
import { routes } from "@glade/app-core/app/routes";
import { connections, environmentLabel, isLocalEnvironment, primaryEnvironmentId, THIS_MACHINE_LABEL } from "@glade/app-core/state/env-registry";
import { Menu, MenuCheckItem } from "@glade/app-core/ui";
import { barButtonClass } from "@glade/app-core/features/chat/context-bar/shared";
import { remoteStateOf, remoteStateShort } from "@glade/app-core/state/remote-status";

export function EnvironmentPicker({ envId }: { envId: string | null }) {
  const navigate = useNavigate();
  const list = connections.value;
  if (list.length < 2) return null;
  const current = envId ?? primaryEnvironmentId();
  const label = environmentLabel(current);
  return (
    <Menu
      side="top"
      contentClass="min-w-[200px]"
      trigger={
        <button type="button" class={barButtonClass} aria-label={`Environment: ${label}`}>
          {isLocalEnvironment(current) ? <Laptop /> : <Globe />}
          <span class="truncate">{label}</span>
          <ChevronDown size={10} strokeWidth={2.5} class="opacity-60" />
        </button>
      }
    >
      {list.map((c) => (
        <MenuCheckItem
          key={c.id}
          checked={c.id === current}
          onSelect={() => navigate(routes.home(c.isLocal ? null : c.id))}
          detail={c.isLocal ? undefined : remoteStateShort(remoteStateOf(c.id))}
        >
          {c.isLocal ? THIS_MACHINE_LABEL : c.name.value}
        </MenuCheckItem>
      ))}
    </Menu>
  );
}
