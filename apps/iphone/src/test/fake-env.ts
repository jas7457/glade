/**
 * Test helper for the iPhone screens: fake paired Macs (connections + saved entries) without
 * sockets or HTTP. `fakeEnv("m1", "Studio")` → an EnvHandle with a live status and an empty shell.
 */
import { computed, signal } from "@preact/signals";
import { defaultSettings, type EnvironmentInfo, type HarnessDefaults, type HarnessInfo, type ModelInfo } from "@glade/protocol";
import type { EnvHandle, EnvShell, EnvStatus } from "@glade/app-core/state/env-registry";
import { environmentAlias } from "@glade/app-core/state/saved-environments";

export function fakeShell(): EnvShell {
  return {
    settings: signal(defaultSettings()),
    models: signal<ModelInfo[]>([]),
    harnessDefaults: signal<HarnessDefaults | null>(null),
    harnesses: signal<HarnessInfo[] | null>(null),
    initialized: signal(true),
    initError: signal<string | null>(null),
  };
}

export function fakeEnv(id: string, ownName: string, status: EnvStatus = "live"): EnvHandle {
  const info = signal<EnvironmentInfo | null>({ id, name: ownName } as EnvironmentInfo);
  return {
    id,
    baseUrl: `http://${id}.test:4327/api`,
    isLocal: false,
    info,
    name: computed(() => environmentAlias(id) ?? info.value?.name ?? id),
    status: signal(status),
    api: {} as EnvHandle["api"],
    request: (async () => undefined) as unknown as EnvHandle["request"],
    socket: {} as EnvHandle["socket"],
    shell: fakeShell(),
    retry: () => {},
  };
}
