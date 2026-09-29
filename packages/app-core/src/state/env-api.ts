/**
 * The API client for whatever you're working on (I-123): every project, workspace (sidebar row)
 * and session belongs to one environment, and its requests go to that environment's server.
 *
 *   apiForSession(sessionId).prompt(sessionId, …)
 *   requestFor(envIdOfProject(projectId))("GET", "/files?…")
 *
 * The local environment (and anything untagged) uses the local client (`lib/api.ts`).
 * Portable client core (F-022).
 */
import { api, type ApiClient, type RequestFn } from "@glade/app-core/lib/api";
import { connectionFor, isLocalEnvironment, localEnvironmentId } from "./env-registry";
import { envIdOfProject, envIdOfSession, envIdOfWorkspace } from "./store";

export function apiFor(envId?: string | null): ApiClient {
  const conn = connectionFor(envId);
  return conn && !conn.isLocal ? conn.api : api;
}

/**
 * Raw requests to an environment, `undefined` for the local one (the `lib/` clients then use
 * their local default). Use `requestFor(env) ?? request` where a function is needed.
 */
export function requestFor(envId?: string | null): RequestFn | undefined {
  const conn = connectionFor(envId);
  return conn && !conn.isLocal ? conn.request : undefined;
}

export const apiForProject = (projectId: string | null | undefined): ApiClient => apiFor(envIdOfProject(projectId));
export const apiForWorkspace = (workspaceId: string): ApiClient => apiFor(envIdOfWorkspace(workspaceId));
export const apiForSession = (sessionId: string): ApiClient => apiFor(envIdOfSession(sessionId));

/**
 * Whether an environment is *this machine* (I-124): host actions that open apps or native
 * dialogs on the host (Open in VS Code, Show in Finder, the osascript folder picker) only make
 * sense then. Needs the capability too once the environment's info is known.
 */
export function isThisMachine(envId: string | null | undefined, capability?: "openIn" | "reveal" | "nativeFolderPicker"): boolean {
  if (!isLocalEnvironment(envId)) return false;
  const conn = connectionFor(envId ?? localEnvironmentId.value);
  const caps = conn?.info.value?.capabilities;
  return !capability || !caps || caps[capability] !== false;
}
