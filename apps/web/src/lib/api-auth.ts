/**
 * Device auth + pairing endpoints (I-125/I-126, contract: @glade/protocol auth.ts).
 *
 * - {@link hostAuthApi}: the host side (Settings → Remote Access on the local environment):
 *   remote switch (with the transport's status), invites, pending confirmations, devices, audit
 *   log, tailnet discovery.
 * - {@link pairRequest}: the client side (no token yet): `POST /api/auth/pair`, long-polling.
 *
 * Portable client core (F-022).
 */
import type {
  AuditEntry,
  DiscoveredEnvironment,
  PairRequest,
  PairResponse,
  PairedDevice,
  PairingInvite,
  PendingPairing,
  RemoteAccessState,
  TailnetPeer,
} from "@glade/protocol";
import { request as localRequest, requestAt, type RequestFn } from "./api";

export function hostAuthApi(request: RequestFn = (method, path, body, headers) => localRequest(method, path, body, headers)) {
  return {
    getRemote: () => request<RemoteAccessState>("GET", "/auth/remote"),
    setRemote: (enabled: boolean) => request<RemoteAccessState>("PATCH", "/auth/remote", { enabled }),
    /** The "Remote access" master switch (I-132). */
    setMaster: (master: boolean) => request<RemoteAccessState>("PATCH", "/auth/remote", { master }),
    createInvite: () => request<PairingInvite>("POST", "/auth/invites"),
    cancelInvite: () => request<void>("DELETE", "/auth/invites/current"),
    listPending: () => request<PendingPairing[]>("GET", "/auth/pending"),
    answerPending: (id: string, allow: boolean) => request<void>("POST", `/auth/pending/${encodeURIComponent(id)}`, { allow }),
    listDevices: () => request<PairedDevice[]>("GET", "/auth/devices"),
    renameDevice: (id: string, name: string) => request<PairedDevice>("PATCH", `/auth/devices/${encodeURIComponent(id)}`, { name }),
    revokeDevice: (id: string) => request<void>("DELETE", `/auth/devices/${encodeURIComponent(id)}`),
    revokeAllDevices: () => request<void>("DELETE", "/auth/devices"),
    listAudit: (limit = 50) => request<AuditEntry[]>("GET", `/auth/audit?limit=${limit}`),
    /** Glade hosts on this Mac's tailnet (I-127). */
    discover: () => request<DiscoveredEnvironment[]>("GET", "/auth/discover"),
    /** This Mac's tailnet peers, online or not (I-132). */
    listPeers: () => request<TailnetPeer[]>("GET", "/auth/peers"),
  };
}

export type HostAuthApi = ReturnType<typeof hostAuthApi>;

/** The local environment's host auth client. */
export const hostAuth: HostAuthApi = hostAuthApi();

/** Ask a host to pair (answers when the host user allows/denies, or on timeout). */
export function pairRequest(apiBase: string, body: PairRequest, signal?: AbortSignal): Promise<PairResponse> {
  return requestAt<PairResponse>(apiBase, "POST", "/auth/pair", body, undefined, { signal });
}
