/**
 * Local models on this Mac (I-196): the model server's state for every device, load and unload.
 *
 *   const lm = new LocalModelsService({ url: () => settings.localModels.url, broadcast, usage, onLoadedChange });
 *   lm.start(); lm.setClientCount(1); await lm.get(true); await lm.load("Qwen…");
 *
 * - Builds {@link LocalModelsState} from the backend (`backend.ts`; llama-server first), adding this
 *   Mac's memory and `usedBy` (chats whose model is that llama.cpp model).
 * - Caches the last state and pushes `local_models` whenever it changes (ignoring `fetchedAt`).
 * - Polls every `fastMs` (2 s) while a model is loading or a load/unload we started hasn't settled,
 *   else every `slowMs` (30 s), and only while a client is connected (like the usage limits
 *   poller), except that our own pending loads/unloads are watched until they settle regardless.
 * - When the set of usable (loaded/sleeping) models changes, calls `onLoadedChange` so the agent's
 *   model list is refreshed (pi only lists llama.cpp models the router has loaded).
 * - A new URL (`urlChanged()`) re-polls at once.
 */
import { totalmem } from "node:os";
import { LLAMA_CPP_PROVIDER, type LocalModel, type LocalModelsState, type ModelRef, type ServerMessage } from "@glade/protocol";
import { LocalModelsError, type LocalModelsBackend } from "./backend.js";
import { LlamaServerBackend } from "./llama-server.js";

/** One chat as far as `usedBy` is concerned. */
export interface LocalModelUser {
  sessionId: string;
  model: ModelRef | null;
  running: boolean;
}

export interface LocalModelsServiceOptions {
  /** The model server's URL (`Settings.localModels.url`), read on every check. */
  url: () => string;
  /** A backend for a URL. Default: {@link LlamaServerBackend} (with `LLAMA_API_KEY` from the env). */
  backend?: (url: string) => LocalModelsBackend;
  broadcast: (message: ServerMessage) => void;
  /** Chats with their models (for `usedBy`). Default: none. */
  users?: () => LocalModelUser[];
  /** The usable models changed (a load finished, an unload, …): refresh the agents' model lists. */
  onLoadedChange?: () => void;
  /** Poll intervals (ms). */
  fastMs?: number;
  slowMs?: number;
  /** How long a load/unload we started is watched before giving up (ms). Default 10 min. */
  pendingTimeoutMs?: number;
  memoryBytes?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

/** How long an accepted load may still show `unloaded` before we stop waiting for it. */
const LOAD_START_GRACE_MS = 10_000;

export class LocalModelsService {
  private state: LocalModelsState | null = null;
  private backendCache: { url: string; backend: LocalModelsBackend } | null = null;
  private inflight: Promise<LocalModelsState> | null = null;
  /** The check queued behind the one in flight. */
  private queued: Promise<LocalModelsState> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private clients = 0;
  private running = false;
  private disposed = false;
  /** Loads/unloads we started, until the model server reports them settled: id → started at. */
  private readonly pending = new Map<string, { kind: "load" | "unload"; at: number }>();
  /** The usable model ids last seen (`null` = not looked yet). */
  private usable: string | null = null;
  private lastUrl: string | null = null;

  constructor(private readonly options: LocalModelsServiceOptions) {}

  /** Start polling (while clients are connected). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    this.disposed = true;
    this.clearTimer();
  }

  /** Number of connected clients; polling only happens while it's > 0 (or something is pending). */
  setClientCount(count: number): void {
    const had = this.clients > 0;
    this.clients = Math.max(0, count);
    if (had !== this.clients > 0) this.schedule(this.clients > 0 ? 0 : undefined);
  }

  /** The last state (possibly old), or `null` before the first check. */
  current(): LocalModelsState | null {
    return this.state;
  }

  /** The `local_models` message for a newly connected client (`null` before the first check). */
  message(): ServerMessage | null {
    return this.state ? { type: "local_models", state: this.state } : null;
  }

  /** The state; asks the model server first when `refresh` or nothing is known yet. */
  async get(refresh = false): Promise<LocalModelsState> {
    if (!refresh && this.state && this.state.url === this.options.url()) return this.state;
    return this.refresh();
  }

  /** The settings changed: a new URL is checked at once. */
  urlChanged(): void {
    if (this.options.url() === this.lastUrl) return;
    this.pending.clear();
    if (this.running || this.state) void this.refresh().catch(() => {});
  }

  /** Chats changed (model or running): recompute `usedBy` without asking the model server. */
  usersChanged(): void {
    if (!this.state) return;
    this.update({ ...this.state, models: this.withUsage(this.state.models) });
  }

  /** Whether a session's model counts for `usedBy` (so callers can skip unrelated changes). */
  static isLocalModel(model: ModelRef | null | undefined): boolean {
    return model?.provider === LLAMA_CPP_PROVIDER;
  }

  async load(id: string, options: { contextLength?: number } = {}): Promise<LocalModelsState> {
    const state = await this.refresh();
    const model = this.require(state, id);
    if (model.status === "loaded" || model.status === "sleeping") throw new LocalModelsError(409, `${model.name} is already loaded`);
    if (model.status === "loading") throw new LocalModelsError(409, `${model.name} is already loading`);
    await this.backend().load(id, options);
    this.pending.set(id, { kind: "load", at: this.now() });
    return this.afterAction();
  }

  async unload(id: string): Promise<LocalModelsState> {
    const state = await this.refresh();
    const model = this.require(state, id);
    if (model.status === "unloaded" || model.status === "failed") throw new LocalModelsError(409, `${model.name} isn't loaded`);
    await this.backend().unload(id);
    this.pending.set(id, { kind: "unload", at: this.now() });
    return this.afterAction();
  }

  /**
   * Ask the model server now and push when changed. Calls during a check get the next check
   * (one is queued), so a caller always sees an answer from after its call.
   */
  refresh(): Promise<LocalModelsState> {
    if (this.inflight) {
      this.queued ??= this.inflight
        .catch(() => {})
        .then(() => {
          this.queued = null;
          return this.refresh();
        });
      return this.queued;
    }
    this.inflight = this.fetchState().finally(() => {
      this.inflight = null;
      if (!this.queued) this.schedule();
    });
    return this.inflight;
  }

  private afterAction(): Promise<LocalModelsState> {
    return this.refresh();
  }

  private require(state: LocalModelsState, id: string): LocalModel {
    if (!state.reachable) throw new LocalModelsError(502, state.error ?? `The model server at ${state.url} isn't reachable`);
    if (state.error) throw new LocalModelsError(502, state.error);
    const model = state.models.find((m) => m.id === id);
    if (!model) throw new LocalModelsError(404, `There's no model ${id} on ${state.url}`);
    return model;
  }

  private async fetchState(): Promise<LocalModelsState> {
    const url = this.options.url();
    if (url !== this.lastUrl) {
      this.lastUrl = url;
      this.usable = null;
    }
    const backend = this.backend();
    let snapshot;
    try {
      snapshot = await backend.list();
    } catch (err) {
      snapshot = { reachable: false, error: (err as Error).message, models: [], maxLoaded: null };
    }
    const next: LocalModelsState = {
      backend: backend.kind,
      url,
      reachable: snapshot.reachable,
      error: snapshot.error,
      models: this.withUsage(snapshot.models),
      maxLoaded: snapshot.maxLoaded,
      memoryBytes: this.options.memoryBytes ?? totalmem(),
      fetchedAt: this.now(),
    };
    // The URL changed while we were asking: this answer is about the old one.
    if (this.options.url() !== url) return next;
    this.settlePending(next);
    this.update(next);
    this.checkUsable(next);
    return next;
  }

  /** Drop pending loads/unloads that settled (or took too long). */
  private settlePending(state: LocalModelsState): void {
    const timeout = this.options.pendingTimeoutMs ?? 10 * 60_000;
    for (const [id, p] of this.pending) {
      const status = state.models.find((m) => m.id === id)?.status;
      const age = this.now() - p.at;
      // A load the server accepted but doesn't report as loading yet stays pending for a moment.
      const settled =
        !state.reachable ||
        status === undefined ||
        (p.kind === "load" ? status !== "loading" && (status !== "unloaded" || age > LOAD_START_GRACE_MS) : status === "unloaded" || status === "failed");
      if (settled || age > timeout) this.pending.delete(id);
    }
  }

  private checkUsable(state: LocalModelsState): void {
    const ids = state.reachable ? state.models.filter((m) => m.status === "loaded" || m.status === "sleeping").map((m) => m.id).sort().join("\n") : "";
    const before = this.usable;
    this.usable = ids;
    if (before !== null && before !== ids) {
      try {
        this.options.onLoadedChange?.();
      } catch (err) {
        this.options.log?.(`local models: refreshing the model list failed: ${(err as Error).message}`);
      }
    }
  }

  private update(next: LocalModelsState): void {
    const prev = this.state;
    this.state = next;
    if (!prev || !sameState(prev, next)) this.options.broadcast({ type: "local_models", state: next });
  }

  private withUsage(models: LocalModel[]): LocalModel[] {
    const users = this.options.users?.() ?? [];
    const counts = new Map<string, { chats: number; working: number }>();
    for (const u of users) {
      if (!LocalModelsService.isLocalModel(u.model)) continue;
      const c = counts.get(u.model!.id) ?? { chats: 0, working: 0 };
      c.chats++;
      if (u.running) c.working++;
      counts.set(u.model!.id, c);
    }
    return models.map((m) => {
      const { usedBy: _old, ...rest } = m;
      const used = counts.get(m.id);
      return used ? { ...rest, usedBy: used } : rest;
    });
  }

  private backend(): LocalModelsBackend {
    const url = this.options.url();
    if (this.backendCache?.url !== url) {
      const make = this.options.backend ?? ((u: string) => new LlamaServerBackend({ url: u, apiKey: process.env.LLAMA_API_KEY || undefined }));
      this.backendCache = { url, backend: make(url) };
    }
    return this.backendCache.backend;
  }

  /** Something is loading/unloading (ours or anyone's): poll fast. */
  private busy(): boolean {
    return this.pending.size > 0 || !!this.state?.models.some((m) => m.status === "loading");
  }

  /**
   * (Re)arm the poll timer: after `delay` ms, else the interval for the current state. Polls while
   * started and a client is connected, and (started or not) while one of our loads/unloads is pending.
   */
  private schedule(delay?: number): void {
    this.clearTimer();
    if (this.disposed || this.inflight) return; // re-armed when the check finishes
    if (!(this.running && this.clients > 0) && this.pending.size === 0) return;
    const wait = delay ?? (this.busy() ? (this.options.fastMs ?? 2000) : (this.options.slowMs ?? 30_000));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().catch((err: Error) => this.options.log?.(`local models: check failed: ${(err as Error).message}`));
    }, wait);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

/** Same state for clients (ignoring `fetchedAt`). */
export function sameState(a: LocalModelsState, b: LocalModelsState): boolean {
  return JSON.stringify({ ...a, fetchedAt: 0 }) === JSON.stringify({ ...b, fetchedAt: 0 });
}
