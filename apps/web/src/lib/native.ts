/**
 * Native OS integrations behind one client API, so features don't care whether we run in a
 * browser (talking to the local server) or inside the Tauri shell.
 */
import { api, ApiRequestError } from "@glade/app-core/lib/api";
import { isDesktop, pickFolderNative } from "@glade/app-core/lib/desktop";

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
  // Desktop app: the window's own sheet-style dialog (plugin-dialog) instead of the server.
  if (isDesktop()) {
    const path = await pickFolderNative(options);
    return path ? { path } : { cancelled: true };
  }
  try {
    return await api.pickFolder(options);
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 501) return { unavailable: true };
    throw err;
  }
}
