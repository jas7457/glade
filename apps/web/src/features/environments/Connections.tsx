/**
 * Settings → Remote Access → Connections (I-136): one list of every other device, both
 * directions merged (`state/connections.ts`), under the two buttons "Connect to a Device…" and
 * "Share This Device…" (`RemoteAccessSettings` owns the dialogs).
 *
 * Each row carries direction labels:
 * - **You use it**: a saved environment, with its status (`state/remote-status.ts`) and Retry /
 *   Pair Again… / Disconnect… (removes it from this device's list).
 * - **Uses this device**: a paired device, last seen and a connected dot, Revoke….
 *
 * I-138: one name per row, set by this device (`nameOfConnection`); Rename (or double-click the
 * name) sets it for both directions at once (`renameConnection`).
 *
 * Glade hosts found on the tailnet that this device doesn't use yet follow as "Connect…" rows,
 * kept fresh while shown (I-137, `use-discovery.ts`) with a Refresh button.
 */
import { useState } from "preact/hooks";
import { Monitor, Plus, RefreshCw, Share } from "lucide-preact";
import type { DiscoveredEnvironment, PairedDevice } from "@glade/protocol";
import { mergeConnections, nameOfConnection, type Connection } from "@/state/connections";
import { connectionFor, localEnvironmentId } from "@/state/env-registry";
import { removeSavedEnvironment, savedEnvironments, type SavedEnvironment } from "@/state/environments";
import { hostRemote, pairedDevices, renameConnection, revokeAllDevices, revokeDevice } from "@/state/remote-host";
import { remoteStateOf, remoteStateText } from "@/state/remote-status";
import { Badge, Button, FormGroup, FormRow, Spinner, TextField, confirm } from "@/ui";
import { formatLastSeen } from "./HostRemoteAccess";
import { DeviceKindIcon } from "./device-kind";
import { useDiscovery } from "./use-discovery";

export interface ConnectionsProps {
  /** Open "Connect to a Device…" (optionally Pair Again with an environment, or a found device). */
  onConnect: (request: { envId?: string; address?: string; name?: string }) => void;
  /** "Share This Device…"; absent without a local server (nothing to share). */
  onShare?: () => void;
}

export function Connections({ onConnect, onShare }: ConnectionsProps) {
  const saved = savedEnvironments.value;
  const devices = pairedDevices.value ?? [];
  const list = mergeConnections(saved, devices);
  const discovery = useDiscovery();
  const found = unknownHosts(discovery.found, saved);
  // The tailnet line (with Refresh) shows once there's a tailnet to look at.
  const tailnet = found.length > 0 || hostRemote.value?.transport?.available === true;

  const revokeAll = async () => {
    const ok = await confirm({
      title: "Revoke all devices?",
      message: `All ${devices.length} devices that use this one lose access at once. They can pair again with a new code.`,
      confirmLabel: "Revoke All",
      destructive: true,
    });
    if (ok) await revokeAllDevices();
  };

  return (
    <FormGroup
      title="Connections"
      actions={
        <>
          {devices.length > 1 && (
            <Button size="sm" variant="ghost" onClick={() => void revokeAll()}>
              Revoke All…
            </Button>
          )}
          <Button size="sm" onClick={() => onConnect({})}>
            <Plus size={12} />
            Connect to a Device…
          </Button>
          {onShare && (
            <Button size="sm" onClick={onShare}>
              <Share size={12} />
              Share This Device…
            </Button>
          )}
        </>
      }
    >
      {list.length === 0 && found.length === 0 && (
        <FormRow
          label={<span class="text-fg-muted">No connections yet.</span>}
          description={
            onShare
              ? "Connect to a Device… uses another computer's projects and chats here. Share This Device… lets another device use this one."
              : "Connect to a Device… uses another computer's projects and chats here."
          }
        />
      )}
      {list.map((c) => (
        <ConnectionRow key={c.key} connection={c} onPair={() => c.environment && onConnect({ envId: c.environment.id })} />
      ))}
      {tailnet && (
        <FormRow
          label={<span class="text-[0.92rem] text-fg-muted">Found on your tailnet</span>}
          description={found.length === 0 ? "No other devices sharing Glade right now." : undefined}
        >
          <Button size="sm" variant="ghost" aria-label="Refresh" disabled={discovery.refreshing} onClick={discovery.refresh}>
            {discovery.refreshing ? <Spinner size={12} /> : <RefreshCw size={12} />}
            Refresh
          </Button>
        </FormRow>
      )}
      {found.map((d) => (
        <FormRow key={d.address} label={d.name} description={`${hostOf(d.address)} · Found on your tailnet`}>
          <Button size="sm" onClick={() => onConnect({ address: d.address, name: d.name })}>
            Connect…
          </Button>
        </FormRow>
      ))}
    </FormGroup>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function ConnectionRow({ connection, onPair }: { connection: Connection; onPair: () => void }) {
  const { environment: env, device } = connection;
  const conn = env ? connectionFor(env.id) : undefined;
  const ownName = conn?.info.value?.name;
  const name = nameOfConnection(connection, ownName);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);

  const disconnect = async () => {
    if (!env) return;
    const ok = await confirm({
      title: "Disconnect?",
      subject: name,
      message: "is removed from this device's list. Nothing on it is deleted; you can connect again later.",
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (ok) removeSavedEnvironment(env.id);
  };

  const revoke = async () => {
    if (!device) return;
    const ok = await confirm({
      title: "Revoke device?",
      subject: name,
      message: "can't use this device anymore (open connections are closed). It can pair again with a new code.",
      confirmLabel: "Revoke",
      destructive: true,
    });
    if (ok) await revokeDevice(device.id).catch((err: Error) => setError(err.message));
  };

  const commit = async () => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === name) {
      setDraft(name);
      return;
    }
    try {
      await renameConnection(connection, next, ownName);
      setError(null);
    } catch (err) {
      setDraft(name);
      setError((err as Error).message);
    }
  };

  const startRename = () => {
    setDraft(name);
    setEditing(true);
  };
  const renameButton = (
    <Button size="sm" onClick={startRename}>
      Rename
    </Button>
  );

  const state = env ? remoteStateOf(env.id) : null;

  return (
    <FormRow
      label={
        <span class="flex min-w-0 items-center gap-2" data-connection={connection.key}>
          {device ? <DeviceKindIcon kind={device.kind} /> : <Monitor size={14} strokeWidth={1.75} class="shrink-0 text-fg-muted" />}
          {editing ? (
            <TextField
              size="sm"
              aria-label="Device name"
              value={draft}
              autoFocus
              onInput={(e) => setDraft(e.currentTarget.value)}
              onBlur={() => void commit()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commit();
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setDraft(name);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <span class="min-w-0 truncate" title="Double-click to rename" onDblClick={startRename}>
              {name}
            </span>
          )}
          {device?.connected && <span aria-label="Connected" class="size-1.5 shrink-0 rounded-full bg-success" />}
        </span>
      }
      description={
        <span class="mt-1 flex flex-col gap-1">
          {env && state && (
            <span class="flex min-w-0 items-center gap-1.5" data-line="uses">
              <Badge>You use it</Badge>
              <span class="min-w-0 flex-1 truncate" data-testid="environment-status">{`${hostOf(env.urls[0] ?? "")} · ${remoteStateText(state, name)}`}</span>
              <span class="flex shrink-0 items-center gap-1.5" data-actions="uses">
                {state === "needs-pairing" && (
                  <Button size="sm" onClick={onPair}>
                    Pair Again…
                  </Button>
                )}
                {(state === "unreachable" || state === "host-offline") && conn?.retry && (
                  <Button size="sm" onClick={() => conn.retry?.()}>
                    Retry
                  </Button>
                )}
                {renameButton}
                <Button size="sm" onClick={() => void disconnect()}>
                  Disconnect…
                </Button>
              </span>
            </span>
          )}
          {device && (
            <span class="flex min-w-0 items-center gap-1.5" data-line="used-by">
              <Badge>Uses this device</Badge>
              <span class="min-w-0 flex-1 truncate" data-testid="device-status">
                {error ? <span class="text-danger">{error}</span> : deviceDetails(device)}
              </span>
              <span class="flex shrink-0 items-center gap-1.5" data-actions="used-by">
                {!env && renameButton}
                <Button size="sm" onClick={() => void revoke()}>
                  Revoke…
                </Button>
              </span>
            </span>
          )}
        </span>
      }
    />
  );
}

function deviceDetails(device: PairedDevice): string {
  const seen = device.connected ? "now" : formatLastSeen(device.lastSeenAt);
  return [`Last seen ${seen}`, device.lastAddress, device.tailscaleLogin].filter(Boolean).join(" · ");
}

/** Found hosts that aren't this device and that it doesn't use yet. */
function unknownHosts(found: DiscoveredEnvironment[], saved: SavedEnvironment[]): DiscoveredEnvironment[] {
  const own = localEnvironmentId.value;
  return found.filter((d) => d.environmentId !== own && !saved.some((s) => s.id === d.environmentId || s.urls.includes(d.address)));
}
