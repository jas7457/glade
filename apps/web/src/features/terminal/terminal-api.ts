/**
 * Terminal tabs' server calls (I-187), sent to the environment that runs the workspace: a remote
 * Mac's chat gets that Mac's shell. REST for start/close (`requestFor` adds a paired device's
 * token), and the socket URL for `/ws/terminal/:id`: the page's own server needs nothing, a paired
 * environment gets a fresh one-time ticket per connect (like the main socket, I-125).
 */
import type { StartTerminalRequest, TerminalInfo } from "@glade/protocol";
import { request, localBaseUrl } from "@glade/app-core/lib/api";
import { wsUrlFromApiBase } from "@glade/app-core/lib/socket";
import { connectionFor } from "@glade/app-core/state/env-registry";
import { requestFor } from "@glade/app-core/state/env-api";
import { envIdOfWorkspace } from "@glade/app-core/state/store";

function send(workspaceId: string) {
  return requestFor(envIdOfWorkspace(workspaceId)) ?? request;
}

/** Start the tab's shell (or get the running one; restarts an exited one). */
export function startTerminal(workspaceId: string, terminalId: string, size: StartTerminalRequest): Promise<TerminalInfo> {
  return send(workspaceId)<TerminalInfo>("POST", `/workspaces/${encodeURIComponent(workspaceId)}/terminals/${encodeURIComponent(terminalId)}/start`, size);
}

/** Close the tab's shell (SIGHUP). */
export function closeTerminal(workspaceId: string, terminalId: string): Promise<void> {
  return send(workspaceId)<void>("DELETE", `/terminals/${encodeURIComponent(terminalId)}`);
}

/** Where to open the tab's socket (with a ticket for a paired environment). */
export async function terminalSocketUrl(workspaceId: string, terminalId: string): Promise<string> {
  const conn = connectionFor(envIdOfWorkspace(workspaceId));
  const baseUrl = conn?.baseUrl ?? localBaseUrl();
  const url = `${wsUrlFromApiBase(baseUrl)}/terminal/${encodeURIComponent(terminalId)}`;
  if (!conn || (conn.isLocal && conn.baseUrl === localBaseUrl())) return url;
  try {
    const { ticket } = await conn.request<{ ticket: string }>("POST", "/auth/ws-ticket");
    return `${url}?ticket=${encodeURIComponent(ticket)}`;
  } catch (err) {
    // The host's own clients connect without one (`not_a_device`); anything else is a real failure.
    if ((err as { code?: string }).code === "not_a_device") return url;
    throw err;
  }
}

/** A short random id for a new terminal tab. */
export function newTerminalId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return `term-${[...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 14)}`;
}
