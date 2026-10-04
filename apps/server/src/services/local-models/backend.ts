/**
 * Local model servers (I-196): what {@link LocalModelsService} needs from one. The first backend
 * is llama.cpp's `llama-server` in router mode (`llama-server.ts`); LM Studio can be another.
 *
 * A backend only talks to its model server and maps its answers to `@glade/protocol` types; the
 * service adds the Mac's memory, `usedBy`, caching, polling and pushes.
 */
import type { LocalModel, LocalModelBackendKind } from "@glade/protocol";

/** One look at the model server. Never throws for "not running" / "wrong mode": that's `error`. */
export interface LocalModelsSnapshot {
  reachable: boolean;
  /** Why it can't be used, in words; `null` when fine. */
  error: string | null;
  /** Without `usedBy` (the service fills it). Sorted: loaded/loading first, then by name. */
  models: LocalModel[];
  maxLoaded: number | null;
}

export interface LocalModelsBackend {
  readonly kind: LocalModelBackendKind;
  /** The model server's base URL as configured. */
  readonly url: string;
  list(): Promise<LocalModelsSnapshot>;
  /** Start loading `id`; resolves once the model server accepted it. Throws {@link LocalModelsError}. */
  load(id: string, options?: { contextLength?: number }): Promise<void>;
  /** Stop `id`'s instance; resolves once the model server accepted it. Throws {@link LocalModelsError}. */
  unload(id: string): Promise<void>;
}

/** A failed load/unload with the HTTP status the API answers with (see `local-models.ts`). */
export class LocalModelsError extends Error {
  constructor(
    /** 404 unknown model, 409 already (not) loaded / limit reached, 502 the model server failed or isn't reachable. */
    readonly status: 404 | 409 | 502,
    message: string,
  ) {
    super(message);
  }
}
