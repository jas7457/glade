/**
 * Harness slash commands for a folder without a chat (I-043): the new-chat composer shows the
 * project's (or the scratch folder's) extension commands, skills and prompts. Cached per folder
 * in a signal; refreshed when the composer mounts or the window regains focus and the entry is
 * older than {@link STALE_MS} (the server caches too).
 *
 * I-185: the commands are the agent's picked in the new-chat composer (`harness`; omitted = the
 * host's default agent), cached per agent and folder.
 *
 * I-213: a `target` folder (a group project's new-chat screen: the picked `folder`) replaces the
 * project's in the request and the cache key.
 */
import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { SlashCommand } from "@glade/protocol";
import { listFolderCommands, type FolderTarget } from "@glade/app-core/lib/api-folder";
import { requestFor } from "@glade/app-core/state/env-api";
import { isLocalEnvironment } from "@glade/app-core/state/env-registry";
import { envIdOfProject } from "@glade/app-core/state/store";

/**
 * Cache key: the project id, or "" for the scratch folder (`@<envId>` for another environment's
 * scratch folder, I-123); `<harness>:` in front for an agent other than the default one (I-185).
 */
function keyOf(projectId: string | null, envId?: string | null, harness?: string | null, target: FolderTarget = {}): string {
  const base = projectId ?? (envId && !isLocalEnvironment(envId) ? `@${envId}` : "");
  const folder = target.workspaceId ? `${base}#ws:${target.workspaceId}` : target.folder ? `${base}#dir:${target.folder}` : base;
  return harness ? `${harness}:${folder}` : folder;
}

const STALE_MS = 30_000;

interface Entry {
  at: number;
  commands: SlashCommand[];
}

/** Keyed by {@link keyOf}. */
export const folderCommands = signal<ReadonlyMap<string, Entry>>(new Map());
const inflight = new Map<string, Promise<void>>();

export function loadFolderCommands(
  projectId: string | null,
  force = false,
  envId?: string | null,
  harness?: string | null,
  target: FolderTarget = {},
): Promise<void> {
  const key = keyOf(projectId, envId, harness, target);
  const hit = folderCommands.value.get(key);
  if (!force && hit && Date.now() - hit.at < STALE_MS) return Promise.resolve();
  let pending = inflight.get(key);
  if (!pending) {
    pending = Promise.resolve()
      .then(() => listFolderCommands(projectId, false, requestFor(projectId ? envIdOfProject(projectId) : envId), harness, target))
      .then((commands) => {
        folderCommands.value = new Map(folderCommands.value).set(key, { at: Date.now(), commands });
      })
      .catch(() => {
        // Not fatal: the menu still shows Glade's built-ins. Retried next time.
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

/**
 * The folder's harness commands (`null` until first loaded) of `harness` (omitted: the default
 * agent); loads/refreshes as described above. `target: null` = no folder yet (a group project
 * before one is picked, I-213): nothing is asked, `null` is returned.
 */
export function useFolderCommands(
  projectId: string | null,
  envId?: string | null,
  harness?: string | null,
  target: FolderTarget | null = {},
): SlashCommand[] | null {
  const workspaceId = target?.workspaceId;
  const folder = target?.folder;
  useEffect(() => {
    if (target === null) return;
    const t: FolderTarget = { ...(workspaceId ? { workspaceId } : {}), ...(folder ? { folder } : {}) };
    void loadFolderCommands(projectId, false, envId, harness, t);
    const onFocus = () => void loadFolderCommands(projectId, false, envId, harness, t);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [projectId, envId, harness, target === null, workspaceId, folder]);
  return target === null ? null : (folderCommands.value.get(keyOf(projectId, envId, harness, target))?.commands ?? null);
}

/** Test helper. */
export function resetFolderCommands(): void {
  folderCommands.value = new Map();
  inflight.clear();
}
