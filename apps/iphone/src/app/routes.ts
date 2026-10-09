/**
 * The iPhone app's screens (I-164). Hash routes (`#/…`), so the bundled page reloads in place
 * inside the Tauri WebView. Build paths with these helpers only.
 */
export const paths = {
  home: () => "/",
  connect: () => "/connect",
  /** A chat (workspace) on an environment; `tab` = a sub-agent's session opened full screen. */
  chat: (envId: string, workspaceId: string, tab?: string | null) =>
    `/e/${encodeURIComponent(envId)}/chats/${encodeURIComponent(workspaceId)}${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`,
  /**
   * The new-chat screen; preselect a Mac, a project and (I-215) a folder of that list the chat
   * starts in (`?env=&project=&folder=`).
   */
  newChat: (target?: { envId?: string | null; projectId?: string | null; folderId?: string | null }) => {
    const query = new URLSearchParams();
    if (target?.envId) query.set("env", target.envId);
    if (target?.projectId) query.set("project", target.projectId);
    if (target?.folderId) query.set("folder", target.folderId);
    const q = query.toString();
    return q ? `/new?${q}` : "/new";
  },
  settings: () => "/settings",
  /** Settings → Voice (conversation mode, I-180). */
  voiceSettings: () => "/settings/voice",
  device: (envId: string) => `/settings/devices/${encodeURIComponent(envId)}`,
  /** A paired Mac's local models (I-196). */
  localModels: (envId: string) => `/settings/devices/${encodeURIComponent(envId)}/local-models`,
};
