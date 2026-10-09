/**
 * The permission modes a new chat can start in (I-184), for the new-chat composer's mode pill
 * (desktop) and the Permissions section of the iPhone's Model & Thinking sheet: the picked agent's
 * modes and its own default (`GET /permission-modes`), per agent, folder and model.
 *
 * Cached in a signal like the folder commands (`slash/folder-commands.ts`): loaded when the
 * composer shows them, refreshed on window focus once older than {@link STALE_MS} (the server
 * caches too). Agents without the `permissionModes` capability are never asked.
 */
import { signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { FolderPermissionModes, ModelRef } from "@glade/protocol";
import { getFolderPermissionModes, type FolderTarget } from "@glade/app-core/lib/api-folder";
import { requestFor } from "@glade/app-core/state/env-api";
import { isLocalEnvironment } from "@glade/app-core/state/env-registry";
import { envIdOfProject } from "@glade/app-core/state/store";

const STALE_MS = 30_000;

interface Entry {
  at: number;
  value: FolderPermissionModes;
}

export interface NewChatModesQuery {
  projectId: string | null;
  /** Standalone chats: the environment (I-123). */
  envId?: string | null;
  /** The agent picked for the new chat; `null`/absent: the host's default agent. */
  harness?: string | null;
  /** The model picked for it (`null`: the agent's default model). */
  model?: ModelRef | null;
  /** Another folder than the project's (I-213: the folder picked for a group project's new chat). */
  target?: FolderTarget;
}

function keyOf({ projectId, envId, harness, model, target }: NewChatModesQuery): string {
  const folder = projectId ?? (envId && !isLocalEnvironment(envId) ? `@${envId}` : "");
  const where = target?.workspaceId ? `ws:${target.workspaceId}` : target?.folder ? `dir:${target.folder}` : "";
  return [harness ?? "", folder, where, model ? `${model.provider}/${model.id}` : ""].join("\0");
}

export const newChatModes = signal<ReadonlyMap<string, Entry>>(new Map());
const inflight = new Map<string, Promise<void>>();

export function loadNewChatModes(q: NewChatModesQuery, force = false): Promise<void> {
  const key = keyOf(q);
  const hit = newChatModes.value.get(key);
  if (!force && hit && Date.now() - hit.at < STALE_MS) return Promise.resolve();
  let pending = inflight.get(key);
  if (!pending) {
    pending = Promise.resolve()
      .then(() => getFolderPermissionModes(q.projectId, q.harness ?? null, q.model ?? null, requestFor(q.projectId ? envIdOfProject(q.projectId) : q.envId), q.target))
      .then((value) => {
        newChatModes.value = new Map(newChatModes.value).set(key, { at: Date.now(), value });
      })
      .catch(() => {
        // Not fatal: no pill; the chat starts in the agent's default. Retried next time.
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

/**
 * The modes a new chat can start in (`null` until loaded, or when `enabled` is false: the agent
 * has no modes). Keeps showing the last loaded list for the agent while another model's loads.
 */
export function useNewChatModes(q: NewChatModesQuery, enabled: boolean): FolderPermissionModes | null {
  const key = keyOf(q);
  const base = keyOf({ ...q, model: null });
  const last = useRef<{ base: string; value: FolderPermissionModes } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    void loadNewChatModes(q);
    const onFocus = () => void loadNewChatModes(q);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [key, enabled]);
  if (!enabled) return null;
  const value = newChatModes.value.get(key)?.value;
  if (value) last.current = { base, value };
  return value ?? (last.current?.base === base ? last.current.value : null);
}

/** Test helper. */
export function resetNewChatModes(): void {
  newChatModes.value = new Map();
  inflight.clear();
}
