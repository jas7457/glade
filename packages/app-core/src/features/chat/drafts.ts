/**
 * Composer drafts (unsent text per chat / new-chat composer), keyed by the composer's `draftKey`
 * (`chat:<sessionId>`, `new:<projectId>`). They live in memory and survive switching chats.
 *
 * I-197: restarting into a new version (`restartNow`, apps/web/src/state/update.ts) saves them to
 * `localStorage` first ({@link saveDraftsForRestart}); the next launch takes them back once when
 * this module loads (the Mac app keeps its origin across launches, I-083). Saved drafts older than
 * {@link RESTORE_WITHIN_MS} are dropped (a restart that never happened).
 */

export const drafts = new Map<string, string>();

export const RESTART_DRAFTS_KEY = "glade.restart-drafts";
export const RESTORE_WITHIN_MS = 10 * 60 * 1000;

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): DraftStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Keeps the current drafts for the next launch (just before a restart). */
export function saveDraftsForRestart(storage: DraftStorage | null = defaultStorage(), now = Date.now()): void {
  if (!storage) return;
  try {
    if (drafts.size === 0) storage.removeItem(RESTART_DRAFTS_KEY);
    else storage.setItem(RESTART_DRAFTS_KEY, JSON.stringify({ savedAt: now, drafts: [...drafts] }));
  } catch {
    // storage full or unavailable: the drafts are lost with the restart, as before
  }
}

/** Takes back drafts saved by {@link saveDraftsForRestart} (once: the saved copy is removed). */
export function restoreDraftsAfterRestart(storage: DraftStorage | null = defaultStorage(), now = Date.now()): void {
  if (!storage) return;
  try {
    const raw = storage.getItem(RESTART_DRAFTS_KEY);
    if (raw === null) return;
    storage.removeItem(RESTART_DRAFTS_KEY);
    const saved = JSON.parse(raw) as { savedAt?: unknown; drafts?: unknown };
    if (typeof saved.savedAt !== "number" || now - saved.savedAt > RESTORE_WITHIN_MS || !Array.isArray(saved.drafts)) return;
    for (const entry of saved.drafts) {
      if (!Array.isArray(entry)) continue;
      const [key, text] = entry as unknown[];
      if (typeof key === "string" && typeof text === "string" && text && !drafts.has(key)) drafts.set(key, text);
    }
  } catch {
    // unreadable: nothing to restore
  }
}

restoreDraftsAfterRestart();
