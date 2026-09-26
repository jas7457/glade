/**
 * Route paths + builders. Every screen is addressable so a browser refresh lands on the same
 * page. Always build links with these helpers instead of hand-writing paths.
 */
export const routes = {
  home: () => "/",
  chat: (chatId: string) => `/chats/${chatId}`,
  project: (projectId: string) => `/projects/${projectId}`,
  projectChat: (projectId: string, chatId: string) => `/projects/${projectId}/chats/${chatId}`,
  settings: (section: SettingsSection = "general") => `/settings/${section}`,
};

export const SETTINGS_SECTIONS = ["general", "models", "appearance", "agent", "archived"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Link to a chat in the right context (inside its project or standalone). */
export function chatPath(chat: { id: string; projectId: string | null }): string {
  return chat.projectId ? routes.projectChat(chat.projectId, chat.id) : routes.chat(chat.id);
}
