/**
 * The environments this client is connected to (I-123, design docs/design/environments-and-store.md
 * §3.3/§5). Every Glade server is an environment; the app is a client of zero or more of them.
 * The *local* one (the server that served this page) is simply the first entry, and may not
 * exist at all (the future iPhone app, F-022).
 *
 * This module only holds the registry (no stores, no sync), so every other state module can read
 * it without import cycles. `state/environments.ts` creates and removes the connections.
 *
 * Portable client core (F-022): no layout or desktop assumptions.
 */
import { computed, signal, type ReadonlySignal, type Signal } from "@preact/signals";
import type { EnvironmentInfo, HarnessDefaults, HarnessInfo, ModelInfo, Settings } from "@glade/protocol";
import type { ApiClient, RequestFn } from "@/lib/api";
import type { Socket } from "@/lib/socket";

/** Id used for the local environment when its server doesn't report one (older servers). */
export const LOCAL_FALLBACK_ID = "local";

/** One environment's copy of the shell data that isn't in the merged lists. */
export interface EnvShell {
  settings: Signal<Settings>;
  models: Signal<ModelInfo[]>;
  harnessDefaults: Signal<HarnessDefaults | null>;
  harnesses: Signal<HarnessInfo[] | null>;
  /** The first shell load (HTTP or sync snapshot) finished. */
  initialized: Signal<boolean>;
  initError: Signal<string | null>;
}

/**
 * - connecting: first connection attempt
 * - live: connected and caught up (sync)
 * - offline: the connection dropped; reconnecting
 * - error: couldn't reach it / refused
 */
export type EnvStatus = "connecting" | "live" | "offline" | "error";

/** A connection to one environment (implemented in `state/environments.ts`). */
export interface EnvHandle {
  /** Permanent environment id (from `GET /api/environment`). */
  readonly id: string;
  /** Absolute API base URL (`http://127.0.0.1:5317/api`). */
  readonly baseUrl: string;
  /** This is the server that served the page. */
  readonly isLocal: boolean;
  readonly info: Signal<EnvironmentInfo | null>;
  readonly name: ReadonlySignal<string>;
  readonly status: Signal<EnvStatus>;
  readonly api: ApiClient;
  /** Raw JSON requests against this environment (feature clients in `lib/`). */
  readonly request: RequestFn;
  readonly socket: Socket;
  readonly shell: EnvShell;
}

/** Connected environments, local first. Only these are shown (remote ones when remote access is on). */
export const connections = signal<EnvHandle[]>([]);

/**
 * Id of the local environment (the page's own server), `null` when there is none (a pure client
 * like the phone app) or before it's known.
 */
export const localEnvironmentId = signal<string | null>(null);

/** Whether this page was served by a Glade server (false: zero-local mode). */
export const hasLocalEnvironment = signal(true);

/** The environment untagged things belong to: the local one, else the first connection. */
export function primaryEnvironmentId(): string {
  return localEnvironmentId.value ?? connections.value[0]?.id ?? LOCAL_FALLBACK_ID;
}

export function connectionFor(envId: string | null | undefined): EnvHandle | undefined {
  const id = envId ?? primaryEnvironmentId();
  return connections.value.find((c) => c.id === id);
}

/** True when `envId` is the local environment (or unknown/untagged, which means local). */
export function isLocalEnvironment(envId: string | null | undefined): boolean {
  if (!envId) return hasLocalEnvironment.value;
  const local = localEnvironmentId.value;
  return local !== null ? envId === local : envId === LOCAL_FALLBACK_ID && hasLocalEnvironment.value;
}

/** More than one environment is connected (the UI then offers environment choices). */
export const multipleEnvironments = computed(() => connections.value.length > 1);

/**
 * What environment lists call the page-origin environment. Not "Local": that word already means
 * "works in the project folder" (vs. Worktree) in the location picker and badge.
 */
export const THIS_MACHINE_LABEL = "This Mac";

/** Display name of an environment ("This Mac" for this machine's, else its name). */
export function environmentLabel(envId: string | null | undefined): string {
  if (isLocalEnvironment(envId)) return THIS_MACHINE_LABEL;
  return connectionFor(envId)?.name.value ?? "Remote";
}

/**
 * The environment the host sections of Settings (Agents, Models, Slash commands, Prompts) show
 * and edit (I-123 §5.3); `null` = the local (primary) one.
 */
export const settingsEnvironmentId = signal<string | null>(null);
