import type { CheckConfig } from "../config.js";
import type { Notifier } from "../notify/index.js";
import type { Store } from "../store.js";
import { runHttpCheck, type CheckResult } from "./http.js";

export class Scheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  private lastOk = new Map<string, boolean>();

  constructor(
    private readonly checks: CheckConfig[],
    private readonly store: Store,
    private readonly notifier: Notifier,
  ) {}

  start(): void {
    for (const check of this.checks) {
      void this.tick(check);
      this.timers.set(check.id, setInterval(() => void this.tick(check), check.intervalSec * 1000));
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  private async tick(check: CheckConfig): Promise<void> {
    const result = await runHttpCheck(check);
    this.store.record(result);
    await this.maybeNotify(check, result);
  }

  private async maybeNotify(check: CheckConfig, result: CheckResult): Promise<void> {
    const previous = this.lastOk.get(check.id);
    this.lastOk.set(check.id, result.ok);
    if (previous === undefined || previous === result.ok) return;
    await this.notifier.send({ check, result, kind: result.ok ? "recovered" : "down" });
  }
}
