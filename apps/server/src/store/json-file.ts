import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A JSON document on disk. Reads synchronously at startup, writes atomically (tmp + rename),
 * and coalesces bursts of writes.
 */
export class JsonFile<T> {
  private value: T;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly path: string,
    fallback: () => T,
    private readonly debounceMs = 50,
  ) {
    this.value = this.read() ?? fallback();
  }

  get(): T {
    return this.value;
  }

  set(value: T): void {
    this.value = value;
    this.schedule();
  }

  /** Write immediately (also flushes a pending debounced write). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.value, null, 2)}\n`);
    renameSync(tmp, this.path);
  }

  private schedule(): void {
    if (this.debounceMs <= 0) return this.flush();
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private read(): T | null {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[pi-ui] could not read ${this.path}: ${(err as Error).message}`);
      }
      return null;
    }
  }
}
