/** Local-models fixtures for tests (I-196). */
import type { LocalModel, LocalModelsState } from "@glade/protocol";

export const GiB = 2 ** 30;

export function makeLocalModel(id: string, extra: Partial<LocalModel> = {}): LocalModel {
  return { id, name: id, status: "unloaded", sizeBytes: 10 * GiB, contextLength: 32768, error: null, usedBy: { chats: 0, working: 0 }, ...extra };
}

/** A reachable llama-server on a 128 GB Mac (budget ~96 GB). */
export function makeLocalModelsState(models: LocalModel[], extra: Partial<LocalModelsState> = {}): LocalModelsState {
  return { backend: "llama-server", url: "http://127.0.0.1:8080", reachable: true, error: null, models, maxLoaded: null, memoryBytes: 128 * GiB, fetchedAt: 1, ...extra };
}
