/**
 * Fake environment connections for tests (I-123): an `EnvHandle` with its own signals and a
 * stubbed API client, registered in `connections` without sockets or network.
 */
import { computed, signal } from "@preact/signals";
import { vi } from "vitest";
import { defaultSettings, type EnvironmentInfo, type HarnessInfo, type ModelInfo } from "@glade/protocol";
import type { ApiClient } from "@glade/app-core/lib/api";
import type { Socket } from "@glade/app-core/lib/socket";
import { connections, hasLocalEnvironment, localEnvironmentId, settingsEnvironmentId, type EnvHandle, type EnvStatus } from "@glade/app-core/state/env-registry";
import { localShell } from "@glade/app-core/state/store";

export interface FakeEnvOptions {
  id: string;
  name?: string;
  baseUrl?: string;
  isLocal?: boolean;
  status?: EnvStatus;
  models?: ModelInfo[];
  harnesses?: HarnessInfo[] | null;
  /** Methods of the API client (others throw). */
  api?: Partial<Record<keyof ApiClient, unknown>>;
}

export function makeModel(provider: string, id: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return { provider, id, name: id, input: ["text"], thinkingLevels: ["off", "low", "medium", "high"], contextWindow: 200_000, ...extra };
}

export function fakeEnv(options: FakeEnvOptions): EnvHandle {
  const info = signal<EnvironmentInfo | null>({
    id: options.id,
    name: options.name ?? options.id,
    version: "0.0.0",
    protocol: 2,
    platform: "darwin",
    hostname: "host",
    home: "/Users/me",
    capabilities: { openIn: true, reveal: true, nativeFolderPicker: true, browse: true, remoteAccess: false },
  });
  const request = vi.fn(async () => undefined);
  const client = new Proxy({ baseUrl: options.baseUrl ?? `http://127.0.0.1:1/api`, request, ...(options.api ?? {}) } as Record<string, unknown>, {
    get: (target, key: string) => (key in target ? target[key] : () => Promise.reject(new Error(`fake env ${options.id}: ${key} not stubbed`))),
  }) as unknown as ApiClient;
  const shell = options.isLocal
    ? localShell
    : {
        settings: signal(defaultSettings()),
        models: signal(options.models ?? []),
        harnessDefaults: signal(null),
        harnesses: signal(options.harnesses ?? null),
        initialized: signal(true),
        initError: signal<string | null>(null),
      };
  if (options.isLocal) {
    if (options.models) localShell.models.value = options.models;
    if (options.harnesses !== undefined) localShell.harnesses.value = options.harnesses;
  }
  return {
    id: options.id,
    baseUrl: options.baseUrl ?? `http://127.0.0.1:1/api`,
    isLocal: options.isLocal ?? false,
    info,
    name: computed(() => info.value?.name ?? options.id),
    status: signal(options.status ?? "live"),
    api: client,
    request: client.request as never,
    socket: { watch: () => () => {} } as unknown as Socket,
    shell,
  };
}

/** Register a local environment `local` plus the given remote ones. */
export function useEnvironments(...remotes: EnvHandle[]): { local: EnvHandle } {
  const local = fakeEnv({ id: "local-env", name: "This Mac", isLocal: true });
  hasLocalEnvironment.value = true;
  localEnvironmentId.value = local.id;
  connections.value = [local, ...remotes];
  return { local };
}

/** Back to "no environments registered" (legacy single-server mode). */
export function resetEnvironmentsForTest(): void {
  connections.value = [];
  localEnvironmentId.value = null;
  hasLocalEnvironment.value = true;
  settingsEnvironmentId.value = null;
}
