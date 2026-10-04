/**
 * Local models (I-196): the models in each Mac's local model server (llama-server) and their
 * status, per environment, fed by the server's `local_models` push (sent on connect and on every
 * change) and by the answers to load/unload/refresh. Actions load and unload a model on any Mac
 * (also another one: that's an action, not a settings change), with an optimistic "loading" and
 * a plain-words toast when it fails. Pure helpers word the sizes, the memory line and the
 * warnings the UI asks before an unload of a model chats use or a load that may not fit.
 *
 *   localModelsOf(envId)            // LocalModelsState | null (nothing heard yet)
 *   await loadLocalModel(envId, id) // true when the model server accepted it
 */
import { signal } from "@preact/signals";
import { gpuBudgetBytes, loadedBytes, type LocalModel, type LocalModelsState } from "@glade/protocol";
import { apiFor } from "./env-api";
import { isLocalEnvironment } from "./env-registry";
import { showToast } from "./toasts";

/** State per environment ({@link localModelsKey}). */
export const localModels = signal<ReadonlyMap<string, LocalModelsState>>(new Map());
/** Model ids with a load/unload request in flight, per environment (`${key}\n${id}`). */
export const localModelsPending = signal<ReadonlySet<string>>(new Set());
/** Environments being refreshed (the header's spinner). */
export const localModelsRefreshing = signal<ReadonlySet<string>>(new Set());
/** Why the last fetch failed per environment (the Mac's Glade itself not reachable, an old server). */
export const localModelsFetchError = signal<ReadonlyMap<string, string>>(new Map());

/** Map key of an environment: "" for this device's own server (also untagged), else its id. */
export function localModelsKey(envId: string | null | undefined): string {
  return !envId || isLocalEnvironment(envId) ? "" : envId;
}

export function localModelsOf(envId: string | null | undefined): LocalModelsState | null {
  return localModels.value.get(localModelsKey(envId)) ?? null;
}

export function isLocalModelPending(envId: string | null | undefined, modelId: string): boolean {
  return localModelsPending.value.has(pendingKey(envId, modelId));
}

/** Apply an environment's `local_models` push (or an API answer). */
export function handleLocalModelsMessage(state: LocalModelsState, envId?: string | null): void {
  const key = localModelsKey(envId);
  const all = new Map(localModels.value);
  all.set(key, state);
  localModels.value = all;
  if (localModelsFetchError.value.has(key)) localModelsFetchError.value = without(localModelsFetchError.value, key);
}

/** Ask the environment's server for the state; `refresh`: it asks the model server now. */
export async function refreshLocalModels(envId: string | null | undefined, refresh = true): Promise<void> {
  const key = localModelsKey(envId);
  localModelsRefreshing.value = new Set([...localModelsRefreshing.value, key]);
  try {
    handleLocalModelsMessage(await apiFor(envId).getLocalModels(refresh), envId);
  } catch (err) {
    // An older Glade on that Mac has no local-models API yet.
    const text = (err as { status?: number }).status === 404 ? "Glade on this Mac doesn't support local models yet. Update it." : errorText(err);
    localModelsFetchError.value = new Map([...localModelsFetchError.value, [key, text]]);
  } finally {
    const next = new Set(localModelsRefreshing.value);
    next.delete(key);
    localModelsRefreshing.value = next;
  }
}

/**
 * Load a model; it shows "loading" right away (the server's pushes take over from there).
 * On failure the previous state comes back and a toast says why. Resolves `true` when accepted.
 */
export async function loadLocalModel(envId: string | null | undefined, modelId: string, contextLength?: number): Promise<boolean> {
  const before = localModelsOf(envId);
  if (before) handleLocalModelsMessage(withStatus(before, modelId, "loading"), envId);
  return run(envId, modelId, "load", () => apiFor(envId).loadLocalModel(modelId, contextLength), before);
}

/** Unload a model (also cancels a load in progress). Resolves `true` when it worked. */
export async function unloadLocalModel(envId: string | null | undefined, modelId: string): Promise<boolean> {
  return run(envId, modelId, "unload", () => apiFor(envId).unloadLocalModel(modelId), null);
}

async function run(
  envId: string | null | undefined,
  modelId: string,
  verb: "load" | "unload",
  call: () => Promise<LocalModelsState>,
  restore: LocalModelsState | null,
): Promise<boolean> {
  const pending = pendingKey(envId, modelId);
  localModelsPending.value = new Set([...localModelsPending.value, pending]);
  try {
    handleLocalModelsMessage(await call(), envId);
    return true;
  } catch (err) {
    // Only undo the optimistic status if nothing newer (a push) replaced it meanwhile.
    const now = localModelsOf(envId);
    if (restore && now && now.fetchedAt === restore.fetchedAt) handleLocalModelsMessage(restore, envId);
    const name = localModelsOf(envId)?.models.find((m) => m.id === modelId)?.name ?? modelId;
    showToast({ level: "error", title: `Couldn't ${verb} ${name}`, message: errorText(err), timeoutMs: 8000 });
    return false;
  } finally {
    const next = new Set(localModelsPending.value);
    next.delete(pending);
    localModelsPending.value = next;
  }
}

function withStatus(state: LocalModelsState, modelId: string, status: LocalModel["status"]): LocalModelsState {
  return { ...state, models: state.models.map((m) => (m.id === modelId ? { ...m, status, error: null } : m)) };
}

function pendingKey(envId: string | null | undefined, modelId: string): string {
  return `${localModelsKey(envId)}\n${modelId}`;
}

function without<V>(map: ReadonlyMap<string, V>, key: string): Map<string, V> {
  const next = new Map(map);
  next.delete(key);
  return next;
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/failed to fetch|networkerror|load failed/i.test(message)) return "Couldn't reach the Mac.";
  return message || "Something went wrong.";
}

// ── Formatting ───────────────────────────────────────────────────────────────

const GB = 2 ** 30;

/** "19.0 GB" (one decimal; memory-style GB = GiB, like macOS shows RAM). */
export function formatGB(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`;
}

/** "~96 GB": the GPU budget, rounded. */
export function formatBudget(bytes: number): string {
  return `~${Math.round(bytes / GB)} GB`;
}

/** "32k context" (`null` when unknown). */
export function formatContext(contextLength: number | null): string | null {
  if (!contextLength) return null;
  return contextLength >= 1024 ? `${Math.round(contextLength / 1024)}k context` : `${contextLength} context`;
}

/** "llama-server · 127.0.0.1:8080" */
export function backendLine(state: Pick<LocalModelsState, "backend" | "url">): string {
  let host = state.url;
  try {
    host = new URL(state.url).host;
  } catch {
    /* keep as is */
  }
  return `${state.backend} · ${host}`;
}

export interface MemoryUse {
  loaded: number;
  budget: number;
  /** 0-100 of the budget. */
  percent: number;
  /** "Loaded 19.0 GB of ~96 GB" */
  label: string;
  over: boolean;
}

export function memoryUse(state: Pick<LocalModelsState, "models" | "memoryBytes">): MemoryUse {
  const loaded = loadedBytes(state);
  const budget = gpuBudgetBytes(state.memoryBytes);
  return {
    loaded,
    budget,
    percent: budget > 0 ? (loaded / budget) * 100 : 0,
    label: `Loaded ${formatGB(loaded)} of ${formatBudget(budget)}`,
    over: budget > 0 && loaded > budget,
  };
}

/** The model server answered and is usable (reachable, and no error like "not in router mode"). */
export function isUsable(state: Pick<LocalModelsState, "reachable" | "error">): boolean {
  return state.reachable && !state.error;
}

/** How many models are loaded (or loading): the iPhone's "2 loaded". */
export function loadedCount(state: Pick<LocalModelsState, "models"> | null): number {
  return state ? state.models.filter((m) => m.status === "loaded" || m.status === "loading").length : 0;
}

/** "1 chat" / "2 chats" */
function chats(n: number): string {
  return `${n} chat${n === 1 ? "" : "s"}`;
}

/** "Used by 2 chats" (`null` when none). */
export function usedByLabel(model: Pick<LocalModel, "usedBy">): string | null {
  const n = model.usedBy?.chats ?? 0;
  return n > 0 ? `Used by ${chats(n)}` : null;
}

export interface ModelWarning {
  title: string;
  message: string;
  confirmLabel: string;
}

/**
 * What to ask before unloading a model chats use ("Unload Qwen3-27B?" "1 chat is working with
 * it."); `null`: nothing uses it, unload right away.
 */
export function unloadWarning(model: Pick<LocalModel, "name" | "usedBy">): ModelWarning | null {
  const working = model.usedBy?.working ?? 0;
  const using = model.usedBy?.chats ?? 0;
  if (working <= 0 && using <= 0) return null;
  const message =
    working > 0
      ? `${chats(working)} ${working === 1 ? "is" : "are"} working with it.`
      : `${chats(using)} ${using === 1 ? "uses" : "use"} it. ${using === 1 ? "It" : "They"} can't answer until it's loaded again.`;
  return { title: `Unload ${model.name}?`, message, confirmLabel: "Unload" };
}

/** Whether loading `model` would push the loaded models over the GPU budget. */
export function wouldOverflow(state: Pick<LocalModelsState, "models" | "memoryBytes">, model: Pick<LocalModel, "sizeBytes">): boolean {
  if (!model.sizeBytes || !state.memoryBytes) return false;
  return loadedBytes(state) + model.sizeBytes > gpuBudgetBytes(state.memoryBytes);
}

/**
 * What to say before a load that may not fit ("This may not fit: 63.0 GB more with 36.9 GB loaded
 * of ~96 GB. Unload a model first?"); `null` when it fits (or sizes are unknown). Still allowed.
 */
export function loadWarning(state: Pick<LocalModelsState, "models" | "memoryBytes">, model: Pick<LocalModel, "name" | "sizeBytes">): ModelWarning | null {
  if (!wouldOverflow(state, model)) return null;
  const { loaded, budget } = memoryUse(state);
  return {
    title: `Load ${model.name}?`,
    message: `This may not fit: ${formatGB(model.sizeBytes ?? 0)} more with ${formatGB(loaded)} loaded of ${formatBudget(budget)}. Unload a model first?`,
    confirmLabel: "Load Anyway",
  };
}

/** The command the "not running" help suggests. */
export const LLAMA_SERVER_COMMAND = "llama-server --models-dir ~/models --no-models-autoload --models-max 0 --jinja -ngl 999 -c 32768 --port 8080";
