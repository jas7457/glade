/**
 * Route paths + builders. Every screen is addressable so a browser refresh lands on the same
 * page. Always build links with these helpers instead of hand-writing paths.
 *
 * `/chats/:id` and `/projects/:pid/chats/:id` show a **workspace** (sidebar row; I-035). The
 * optional `?tab=<sessionId>` picks its main tab, so a refresh restores the focused tab; without
 * it the workspace's saved/first tab is shown.
 */
export const TAB_PARAM = "tab";

const withTab = (path: string, tab?: string | null) => (tab ? `${path}?${TAB_PARAM}=${encodeURIComponent(tab)}` : path);

export const routes = {
  home: () => "/",
  chat: (workspaceId: string, tab?: string | null) => withTab(`/chats/${workspaceId}`, tab),
  project: (projectId: string) => `/projects/${projectId}`,
  projectChat: (projectId: string, workspaceId: string, tab?: string | null) =>
    withTab(`/projects/${projectId}/chats/${workspaceId}`, tab),
  settings: (section: SettingsSection = "general") => `/settings/${section}`,
};

export const SETTINGS_SECTIONS = ["general", "models", "appearance", "agent", "commands", "prompts"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Link to a workspace in the right context (inside its project or standalone), optionally a tab. */
export function chatPath(workspace: { id: string; projectId: string | null }, tab?: string | null): string {
  return workspace.projectId ? routes.projectChat(workspace.projectId, workspace.id, tab) : routes.chat(workspace.id, tab);
}
