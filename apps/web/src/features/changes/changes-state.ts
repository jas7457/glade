/**
 * Changes panel state (I-097): the last git status per workspace, shared by the header button
 * (its count) and the panel. Refreshed when the workspace screen mounts, when a run in the
 * workspace ends, when the panel opens, and by hand (refresh button). Overlapping refreshes of
 * one workspace share a request.
 *
 *   const entry = changesEntry(workspaceId);   // entry.status.value, entry.loading.value
 *   await refreshChanges(workspaceId);
 */
import { signal, type Signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { GitChangesResponse } from "@glade/protocol";
import { changesApi } from "./api";

export interface ChangesEntry {
  /** `null` until the first status arrives. */
  status: Signal<GitChangesResponse | null>;
  loading: Signal<boolean>;
  error: Signal<string | null>;
  /** Bumped on every successful refresh (open diffs reload on it). */
  version: Signal<number>;
}

const entries = new Map<string, ChangesEntry>();
const inFlight = new Map<string, Promise<void>>();

export function changesEntry(workspaceId: string): ChangesEntry {
  let entry = entries.get(workspaceId);
  if (!entry) {
    entry = { status: signal(null), loading: signal(false), error: signal(null), version: signal(0) };
    entries.set(workspaceId, entry);
  }
  return entry;
}

/** Number of changed files, `null` when unknown or not a repository. */
export function changedCount(workspaceId: string): number | null {
  const status = changesEntry(workspaceId).status.value;
  return status?.isRepo ? status.files.length : null;
}

export function setChanges(workspaceId: string, status: GitChangesResponse): void {
  const entry = changesEntry(workspaceId);
  entry.status.value = status;
  entry.error.value = null;
  entry.version.value++;
}

export function refreshChanges(workspaceId: string): Promise<void> {
  const running = inFlight.get(workspaceId);
  if (running) return running;
  const entry = changesEntry(workspaceId);
  entry.loading.value = true;
  const promise = changesApi
    .status(workspaceId)
    .then((status) => setChanges(workspaceId, status))
    .catch((err: Error) => {
      entry.error.value = err.message;
    })
    .finally(() => {
      entry.loading.value = false;
      inFlight.delete(workspaceId);
    });
  inFlight.set(workspaceId, promise);
  return promise;
}

/** Refresh on mount and whenever a run in the workspace ends (`running` true → false). */
export function useChangesAutoRefresh(workspaceId: string, running: boolean | undefined): void {
  const wasRunning = useRef(running);
  useEffect(() => {
    void refreshChanges(workspaceId);
  }, [workspaceId]);
  useEffect(() => {
    if (wasRunning.current && !running) void refreshChanges(workspaceId);
    wasRunning.current = running;
  }, [workspaceId, running]);
}

/** Tests only. */
export function resetChangesState(): void {
  entries.clear();
  inFlight.clear();
}
