/**
 * Local models (I-196): load and unload models in a local model server on the Mac Glade runs on,
 * from that Mac or any paired device (iPhone, another Mac).
 *
 * The first backend is llama.cpp's `llama-server` in router mode (started without `-m`, with
 * `--models-dir`): `GET /models` lists every model it found with its status, `POST /models/load`
 * and `POST /models/unload` with `{ model }` start/stop a model's instance. LM Studio
 * (`/api/v1/models`, `/api/v1/models/load|unload`) can be another backend later. Glade's server
 * talks to the model server on the same Mac (it never needs to be reachable from the network);
 * devices only talk to Glade.
 *
 *   GET  /api/local-models[?refresh=1]  → LocalModelsState (refresh: ask the model server now)
 *   POST /api/local-models/load         { model, contextLength? } → LocalModelsState
 *   POST /api/local-models/unload       { model }                 → LocalModelsState
 *
 * Load returns as soon as the model server accepted it (the model then shows `loading`); the
 * server watches until it settles and pushes `local_models` on every change. Errors: 404 unknown
 * model, 409 already loaded / not loaded, 502 the model server failed or isn't reachable.
 */

export type LocalModelBackendKind = "llama-server";

export type LocalModelStatus =
  /** Found on disk, not in memory. */
  | "unloaded"
  /** Being loaded (can take tens of seconds for big models). */
  | "loading"
  /** In memory and ready. */
  | "loaded"
  /** Loaded but idle-unloaded by the model server; wakes on the next request. */
  | "sleeping"
  /** The last load failed (`error` says why). */
  | "failed";

export interface LocalModel {
  /** The model server's id (llama-server: the file stem / preset name). Used for load/unload. */
  id: string;
  /** Display name (the id without quantization noise when it's obvious, else the id). */
  name: string;
  status: LocalModelStatus;
  /** Size of the weights in bytes (file size); `null` when unknown. */
  sizeBytes: number | null;
  /** Context length it's loaded with (or will be); `null` when unknown. */
  contextLength: number | null;
  /** Why the last load failed (status `failed`), in words. */
  error?: string | null;
  /**
   * Chats on this server whose model is this one (provider `llama.cpp`), so the UI can warn
   * before unloading it ("2 chats are using this"). `working`: how many are mid-run.
   */
  usedBy?: { chats: number; working: number };
}

export interface LocalModelsState {
  backend: LocalModelBackendKind;
  /** The model server's base URL as configured (e.g. `http://127.0.0.1:8080`). */
  url: string;
  /** The model server answered the last check. */
  reachable: boolean;
  /**
   * Why it can't be used, in words (not running, not in router mode, …); `null` when fine. The
   * UI shows it with setup help.
   */
  error: string | null;
  /** Every model the server knows, loaded ones first, then by name. */
  models: LocalModel[];
  /** How many models it keeps loaded at most (llama-server `--models-max`); `null` = unknown/unlimited. */
  maxLoaded: number | null;
  /** This Mac's memory (RAM, unified on Apple silicon) in bytes. */
  memoryBytes: number;
  /** When the model server was last asked (ms since epoch). */
  fetchedAt: number;
}

export interface LoadLocalModelRequest {
  model: string;
  /** Context length to load with; omitted = the model server's default (`-c` / preset). */
  contextLength?: number;
}

export interface UnloadLocalModelRequest {
  model: string;
}

/** The pi provider id of llama.cpp models (`ModelRef.provider`), to match chats to local models. */
export const LLAMA_CPP_PROVIDER = "llama.cpp";

/** Total bytes of the loaded (and loading) models whose size is known. */
export function loadedBytes(state: Pick<LocalModelsState, "models">): number {
  return state.models.reduce((sum, m) => (m.status === "loaded" || m.status === "loading" ? sum + (m.sizeBytes ?? 0) : sum), 0);
}

/**
 * Roughly how much memory the GPU may use on Apple silicon: macOS caps the Metal working set at
 * ~75% of RAM on Macs with 64 GB or more, ~65% below that (llama.cpp logs it as
 * `recommendedMaxWorkingSetSize`).
 */
export function gpuBudgetBytes(memoryBytes: number): number {
  return Math.round(memoryBytes * (memoryBytes >= 64 * 2 ** 30 ? 0.75 : 0.65));
}
