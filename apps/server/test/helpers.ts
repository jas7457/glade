/**
 * Test helpers: an AppService wired to a FakeHarness and a throwaway data dir.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "@pi-ui/protocol";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import { AppService, type AppServiceOptions } from "../src/services/app-service.js";
import { Store } from "../src/store/store.js";

export interface TestEnv {
  dir: string;
  store: Store;
  harness: FakeHarness;
  service: AppService;
  messages: ServerMessage[];
  cleanup: () => Promise<void>;
}

export function createTestEnv(options: Pick<AppServiceOptions, "revealPath"> = {}): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "pi-ui-test-"));
  const store = new Store(join(dir, "data"), 0);
  const harness = new FakeHarness();
  const service = new AppService({ store, harness, scratchDir: join(dir, "scratch"), ...options });
  const messages: ServerMessage[] = [];
  service.subscribe((m) => messages.push(m));
  return {
    dir,
    store,
    harness,
    service,
    messages,
    cleanup: async () => {
      await service.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Let the fake harness play its queued events. */
export function flush(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Poll until `predicate` holds (fails the test after `timeoutMs`). */
export async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await flush(2);
  }
}
