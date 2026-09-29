/**
 * What a remote environment's status means for the user (I-132), the same everywhere: the globe
 * popover, the sidebar and Settings → Connections.
 *
 * - **connected**
 * - **connecting**: first attempt, or reconnecting right after a drop
 * - **remote-disabled** "Remote access turned off on <name>": the last refusal was 4403 / 403
 *   `remote_disabled`, remembered in the saved list even once the host is unreachable (turning
 *   remote access off there also removes its Tailscale Serve)
 * - **host-offline** "<name> is offline": unreachable, and this device's Tailscale reports that
 *   machine offline (`GET /api/auth/peers` on the local server; best effort, no local server
 *   = no peers, as on the phone)
 * - **unreachable** "Can't reach <name>": unreachable for another reason (Retry)
 * - **needs-pairing**: 401 / revoked, or saved without a token
 *
 * Connections reconnect on their own with backoff (`lib/socket.ts`); these update live.
 * Portable client core (F-022).
 */
import { computed, effect, signal } from "@preact/signals";
import type { TailnetPeer } from "@glade/protocol";
import { hostAuth } from "@glade/app-core/lib/api-auth";
import { connectionFor, connections, hasLocalEnvironment, type EnvStatus } from "./env-registry";
import { savedEnvironments } from "./saved-environments";

export type RemoteState = "connecting" | "connected" | "remote-disabled" | "host-offline" | "unreachable" | "needs-pairing";

export interface RemoteStateInput {
  /** The connection's status; undefined = no connection. */
  status: EnvStatus | undefined;
  hasToken: boolean;
  /** The saved entry remembers a "remote access is off" refusal. */
  rememberedDisabled: boolean;
  /** This device's Tailscale says the host is online (true), offline (false), or doesn't know. */
  peerOnline: boolean | undefined;
}

/** Pure: the user-facing state from the connection and what's remembered. */
export function deriveRemoteState({ status, hasToken, rememberedDisabled, peerOnline }: RemoteStateInput): RemoteState {
  if (!hasToken || status === "needs-pairing") return "needs-pairing";
  if (status === "live") return "connected";
  if (status === "remote-disabled" || rememberedDisabled) return "remote-disabled";
  if (status === "connecting" || status === undefined) return "connecting";
  return peerOnline === false ? "host-offline" : "unreachable";
}

/** Text for a state ("Remote access turned off on Studio"). */
export function remoteStateText(state: RemoteState, name: string): string {
  switch (state) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "remote-disabled":
      return `Remote access turned off on ${name}`;
    case "host-offline":
      return `${name} is offline`;
    case "unreachable":
      return `Can't reach ${name}`;
    case "needs-pairing":
      return "Needs pairing";
  }
}

/** Short form for menus and pickers ("remote" when connected). */
export function remoteStateShort(state: RemoteState): string {
  switch (state) {
    case "connected":
      return "remote";
    case "connecting":
      return "connecting…";
    case "remote-disabled":
      return "remote access off";
    case "host-offline":
      return "offline";
    case "unreachable":
      return "can't reach";
    case "needs-pairing":
      return "needs pairing";
  }
}

/** Not connected and not about to be: its projects and chats are hidden, a status row shows instead. */
export function isDown(state: RemoteState): boolean {
  return state !== "connected" && state !== "connecting";
}

// Tailnet peers ------------------------------------------------------------------------------------

/** This device's tailnet peers by DNS name → online; `null` = unknown (no local server, Tailscale off…). */
export const tailnetPeers = signal<ReadonlyMap<string, boolean> | null>(null);

export async function refreshPeers(): Promise<void> {
  if (!hasLocalEnvironment.value) return;
  try {
    const list = (await hostAuth.listPeers()) as TailnetPeer[] | unknown;
    tailnetPeers.value = Array.isArray(list) ? new Map(list.filter((p) => p && typeof p.dnsName === "string").map((p) => [p.dnsName.toLowerCase(), p.online === true])) : null;
  } catch {
    tailnetPeers.value = null;
  }
}

function hostnameOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Whether Tailscale here says the machine at `url` is online (undefined: not a known peer). */
export function peerOnlineFor(url: string | undefined): boolean | undefined {
  const host = hostnameOf(url);
  return host ? tailnetPeers.value?.get(host) : undefined;
}

// Per environment ---------------------------------------------------------------------------------

/** The state of a saved remote environment (reads the signals, so components update live). */
export function remoteStateOf(envId: string): RemoteState {
  const saved = savedEnvironments.value.find((e) => e.id === envId);
  const conn = connectionFor(envId);
  const hasToken = saved ? !!saved.token : true;
  return deriveRemoteState({
    status: conn && !conn.isLocal ? conn.status.value : undefined,
    hasToken,
    rememberedDisabled: saved?.remoteDisabled === true,
    peerOnline: peerOnlineFor(saved?.urls[0] ?? conn?.baseUrl),
  });
}

/** Remote environments that are down right now (ids), for hiding their items. */
export const downEnvironments = computed(() => new Set(connections.value.filter((c) => !c.isLocal && isDown(remoteStateOf(c.id))).map((c) => c.id)));

const PEERS_POLL_MS = 20_000;

/** Some remote environment is unreachable (only then do the tailnet peers matter). */
function anyUnreachable(): boolean {
  return connections.value.some((c) => !c.isLocal && (c.status.value === "offline" || c.status.value === "error"));
}

/**
 * Refresh the peers now if they matter (I-142: window focus / visible, Settings → Remote Access
 * opening), without waiting for the 20 s poll.
 */
export function refreshPeersIfNeeded(): Promise<void> {
  return anyUnreachable() ? refreshPeers() : Promise.resolve();
}

/**
 * While any remote environment is unreachable, ask the local server for tailnet peers now and
 * every 20 s (to tell "offline" from "can't reach"); also on focus / visibility and when Settings →
 * Remote Access opens (`refreshPeersIfNeeded`, I-142). Call once with a local server; returns stop.
 */
export function watchPeers(): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = effect(() => {
    const unreachable = anyUnreachable();
    if (unreachable && !timer) {
      void refreshPeers();
      timer = setInterval(() => void refreshPeers(), PEERS_POLL_MS);
    } else if (!unreachable && timer) {
      clearInterval(timer);
      timer = null;
    }
  });
  return () => {
    stop();
    if (timer) clearInterval(timer);
    timer = null;
  };
}
