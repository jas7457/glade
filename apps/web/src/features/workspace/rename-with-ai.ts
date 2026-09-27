/**
 * "Rename with AI" (I-101): the small model names a session from its conversation, applied like a
 * rename (`POST /api/sessions/:id/title/generate`, I-074; the server pushes the new titles). Used
 * by the ⌘K palette and the tab context menu. Failures show a toast.
 */
import { api } from "@/lib/api";
import { dismissToast, notify, showToast } from "@/state/toasts";

export async function renameWithAi(sessionId: string): Promise<boolean> {
  const naming = showToast({ level: "info", message: "Naming this chat…", timeoutMs: 60_000 });
  try {
    const { title } = await api.generateSessionTitle(sessionId);
    dismissToast(naming);
    notify("success", `Renamed to “${title}”`);
    return true;
  } catch (err) {
    dismissToast(naming);
    notify("error", `Could not name the chat: ${(err as Error).message}`);
    return false;
  }
}
