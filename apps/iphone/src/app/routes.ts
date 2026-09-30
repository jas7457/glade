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
  newChat: () => "/new",
  settings: () => "/settings",
  /** Settings → Voice (conversation mode, I-180). */
  voiceSettings: () => "/settings/voice",
  device: (envId: string) => `/settings/devices/${encodeURIComponent(envId)}`,
};
