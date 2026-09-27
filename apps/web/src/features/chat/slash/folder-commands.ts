/**
 * Harness slash commands for a folder without a chat (I-043): the new-chat composer shows the
 * project's (or the scratch folder's) extension commands, skills and prompts. Cached per folder
 * in a signal; refreshed when the composer mounts or the window regains focus and the entry is
 * older than {@link STALE_MS} (the server caches too).
 */
import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { SlashCommand } from "@pi-ui/protocol";
import { listFolderCommands } from "@/lib/api-folder";

const STALE_MS = 30_000;

interface Entry {
  at: number;
  commands: SlashCommand[];
}

/** Keyed by project id ("" = scratch folder). */
export const folderCommands = signal<ReadonlyMap<string, Entry>>(new Map());
const inflight = new Map<string, Promise<void>>();

export function loadFolderCommands(projectId: string | null, force = false): Promise<void> {
  const key = projectId ?? "";
  const hit = folderCommands.value.get(key);
  if (!force && hit && Date.now() - hit.at < STALE_MS) return Promise.resolve();
  let pending = inflight.get(key);
  if (!pending) {
    pending = Promise.resolve()
      .then(() => listFolderCommands(projectId))
      .then((commands) => {
        folderCommands.value = new Map(folderCommands.value).set(key, { at: Date.now(), commands });
      })
      .catch(() => {
        // Not fatal: the menu still shows pi-ui's built-ins. Retried next time.
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

/** The folder's harness commands (`null` until first loaded); loads/refreshes as described above. */
export function useFolderCommands(projectId: string | null): SlashCommand[] | null {
  useEffect(() => {
    void loadFolderCommands(projectId);
    const onFocus = () => void loadFolderCommands(projectId);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [projectId]);
  return folderCommands.value.get(projectId ?? "")?.commands ?? null;
}

/** Test helper. */
export function resetFolderCommands(): void {
  folderCommands.value = new Map();
  inflight.clear();
}
