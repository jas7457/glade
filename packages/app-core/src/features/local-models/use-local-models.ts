/**
 * The local-models screen's logic (I-196), shared by the desktop panel and the iPhone screen,
 * which only differ in how they look: the environment's state (refreshed when the screen opens),
 * and Load / Unload that first ask (`ask`, each app's own confirm) when a load may not fit in
 * memory or an unload hits a model chats use.
 *
 *   const lm = useLocalModels(envId, (w) => confirm({ ...w, destructive: true }));
 */
import { useEffect } from "preact/hooks";
import type { LocalModel } from "@glade/protocol";
import {
  isLocalModelPending,
  loadLocalModel,
  loadWarning,
  localModelsFetchError,
  localModelsKey,
  localModelsOf,
  localModelsRefreshing,
  refreshLocalModels,
  unloadLocalModel,
  unloadWarning,
  type ModelWarning,
} from "@glade/app-core/state/local-models";

/** Ask before an action; resolves `true` to go ahead. `kind` says which warning it is. */
export type AskFn = (warning: ModelWarning, kind: "unload" | "load") => Promise<boolean>;

export function useLocalModels(envId: string | null | undefined, ask: AskFn) {
  const key = localModelsKey(envId);
  useEffect(() => {
    void refreshLocalModels(envId);
  }, [key]);

  const state = localModelsOf(envId);
  const load = async (model: LocalModel) => {
    const warning = state ? loadWarning(state, model) : null;
    if (warning && !(await ask(warning, "load"))) return;
    await loadLocalModel(envId, model.id);
  };
  const unload = async (model: LocalModel) => {
    // Cancelling a load needs no question: nothing uses it yet.
    const warning = model.status === "loading" ? null : unloadWarning(model);
    if (warning && !(await ask(warning, "unload"))) return;
    await unloadLocalModel(envId, model.id);
  };
  return {
    state,
    /** The Mac's Glade didn't answer (or is too old for local models); `null` when fine. */
    fetchError: localModelsFetchError.value.get(key) ?? null,
    refreshing: localModelsRefreshing.value.has(key),
    refresh: () => refreshLocalModels(envId),
    pending: (model: LocalModel) => isLocalModelPending(envId, model.id),
    load,
    unload,
  };
}

/** What a row's button does: Load (unloaded/failed), Unload (loaded/sleeping), Cancel (loading). */
export function rowAction(model: Pick<LocalModel, "status">): "load" | "unload" | "cancel" {
  if (model.status === "loading") return "cancel";
  return model.status === "loaded" || model.status === "sleeping" ? "unload" : "load";
}

export const STATUS_LABEL: Record<LocalModel["status"], string | null> = {
  loaded: "Loaded",
  loading: "Loading…",
  sleeping: "Sleeping",
  failed: "Failed",
  unloaded: null,
};
