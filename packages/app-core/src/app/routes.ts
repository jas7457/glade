/**
 * Route paths + builders. Every screen is addressable so a browser refresh lands on the same
 * page. Always build links with these helpers instead of hand-writing paths.
 *
 * `/chats/:id` and `/projects/:pid/chats/:id` show a **workspace** (sidebar row; I-035). The
 * optional `?tab=<sessionId>` picks its main tab, so a refresh restores the focused tab; without
 * it the workspace's saved/first tab is shown.
 *
 * I-123: screens of another environment are prefixed with `/e/:envId`
 * (`/e/:envId/projects/:pid/chats/:id`; `/e/:envId` alone is its new-chat screen). Paths without
 * the prefix mean the local environment, so old links and the remembered last route keep
 * working. The helpers resolve the environment of the project/workspace when it isn't given.
 */
import { isLocalEnvironment } from "@glade/app-core/state/env-registry";
import { envIdOfProject, envIdOfWorkspace } from "@glade/app-core/state/store";

export const TAB_PARAM = "tab";

const withTab = (path: string, tab?: string | null) => (tab ? `${path}?${TAB_PARAM}=${encodeURIComponent(tab)}` : path);

/** `""` for the local environment, `/e/<id>` for another one. */
export function envPrefix(envId: string | null | undefined): string {
  return !envId || isLocalEnvironment(envId) ? "" : `/e/${encodeURIComponent(envId)}`;
}

/** Split `/e/:envId/rest` into the environment (null = local) and the local-style path. */
export function parseEnvPath(pathname: string): { envId: string | null; path: string } {
  const m = /^\/e\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m) return { envId: null, path: pathname };
  return { envId: decodeURIComponent(m[1]!), path: m[2] && m[2] !== "/" ? m[2] : "/" };
}

export const routes = {
  /** New chat (standalone); `envId`: on another environment. */
  home: (envId?: string | null) => envPrefix(envId) || "/",
  chat: (workspaceId: string, tab?: string | null, envId: string | null = envIdOfWorkspace(workspaceId)) =>
    withTab(`${envPrefix(envId)}/chats/${workspaceId}`, tab),
  project: (projectId: string, envId: string | null = envIdOfProject(projectId)) => `${envPrefix(envId)}/projects/${projectId}`,
  projectChat: (projectId: string, workspaceId: string, tab?: string | null, envId: string | null = envIdOfProject(projectId)) =>
    withTab(`${envPrefix(envId)}/projects/${projectId}/chats/${workspaceId}`, tab),
  /** A settings section; without one, `/settings` reopens the last section you had open (I-133). */
  settings: (section?: SettingsSection) => (section ? `/settings/${section}` : "/settings"),
  /** One agent's page under Settings → Agents (I-198): its version, defaults and models. */
  settingsAgent: (harnessId: string) => `/settings/agent/${encodeURIComponent(harnessId)}`,
};

// `about` and `appearance` were folded into General (I-160, I-161); their old links open General.
// `models` was folded into Agents (I-198): `/settings/models` opens Agents.
export const SETTINGS_SECTIONS = ["general", "agent", "commands", "prompts", "local-models", "remote"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/**
 * Link to a workspace in the right context (inside its project or standalone, on its
 * environment), optionally a tab.
 */
export function chatPath(workspace: { id: string; projectId: string | null; environmentId?: string }, tab?: string | null): string {
  const envId = workspace.environmentId ?? envIdOfWorkspace(workspace.id);
  return workspace.projectId ? routes.projectChat(workspace.projectId, workspace.id, tab, envId) : routes.chat(workspace.id, tab, envId);
}
