/**
 * Native OS integrations behind one client API, so features don't care whether we run in a
 * browser (talking to the local server) or inside the Tauri shell.
 */
import { api, ApiRequestError } from "./api";

export interface PickFolderOptions {
  /** Text shown in the dialog. */
  prompt?: string;
  /** Folder the dialog starts in (absolute path). */
  defaultPath?: string;
}

/**
 * - `{ path }`: the absolute path the user chose
 * - `{ cancelled: true }`: the user dismissed the dialog
 * - `{ unavailable: true }`: no native picker here (e.g. the server isn't on macOS); ask for a path
 */
export type PickFolderResult = { path: string } | { cancelled: true } | { unavailable: true };

/** Show the native "choose folder" dialog. Throws for unexpected failures. */
export async function pickFolder(options: PickFolderOptions = {}): Promise<PickFolderResult> {
  // TODO(tauri): when running inside the Tauri shell, use the dialog plugin instead of the server:
  //   if ("__TAURI_INTERNALS__" in window) {
  //     const { open } = await import("@tauri-apps/plugin-dialog");
  //     const path = await open({ directory: true, title: options.prompt, defaultPath: options.defaultPath });
  //     return typeof path === "string" ? { path } : { cancelled: true };
  //   }
  try {
    return await api.pickFolder(options);
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 501) return { unavailable: true };
    throw err;
  }
}
