import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { withFileLock } from "./file-lock.js";

/** Called when the value changed because of what another process wrote (never for our own ops). */
export type ExternalChangeListener<T> = (previous: T, next: T) => void;

/**
 * A JSON document on disk, safe to share between processes (I-062: several Glade servers may use
 * one data folder).
 *
 * Changes are recorded as operations (`update(fn)`), applied to the in-memory value right away
 * and written in coalesced bursts. A write takes the file's lock (file-lock.ts), **re-reads the
 * file**, replays the pending operations on what's there, and writes atomically (tmp + rename),
 * so a change another server made in the meantime is kept rather than overwritten. Operations
 * must therefore be functions of the current document (e.g. "replace the record with id X"),
 * not snapshots of the whole file. `set(value)` is a whole-document replacement, for caches.
 *
 * `reload()` picks up what other processes wrote (the store calls it from a folder watcher and
 * a poll); listeners get the before/after values, pending local operations re-applied on top.
 */
export class JsonFile<T> {
  private value: T;
  private timer: NodeJS.Timeout | null = null;
  /** Local operations not written yet, in order. */
  private ops: Array<(value: T) => T> = [];
  /** mtime/size/inode of the file as we last read or wrote it (skip re-reading unchanged files). */
  private signature: string | null = null;
  private readonly listeners = new Set<ExternalChangeListener<T>>();

  constructor(
    readonly path: string,
    private readonly fallback: () => T,
    private readonly debounceMs = 50,
  ) {
    this.value = this.readDisk() ?? fallback();
  }

  get(): T {
    return this.value;
  }

  /** Apply `fn` now (in memory) and on disk with the next write, on top of the file's content. */
  update(fn: (value: T) => T): void {
    this.ops.push(fn);
    this.value = fn(this.value);
    this.schedule();
  }

  /** Replace the whole document (last writer wins; for caches and one-off rewrites). */
  set(value: T): void {
    this.update(() => value);
  }

  /** True while local changes wait to be written. */
  get dirty(): boolean {
    return this.ops.length > 0;
  }

  onExternalChange(listener: ExternalChangeListener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Write pending operations now, merged with the file's current content under its lock. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.ops.length) return;
    const ops = this.ops;
    this.ops = [];
    let next!: T;
    withFileLock(this.path, () => {
      const base = this.readDisk() ?? this.fallback();
      next = ops.reduce((value, op) => op(value), base);
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
      renameSync(tmp, this.path);
      this.signature = this.statSignature();
    });
    this.adopt(next);
  }

  /**
   * Re-read the file if another process changed it. Returns true when the value changed.
   * An unreadable file is ignored (writers rename atomically, so that means real corruption).
   */
  reload(): boolean {
    const signature = this.statSignature();
    if (signature === this.signature) return false;
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return false;
    }
    let disk: T;
    try {
      disk = JSON.parse(text) as T;
    } catch {
      return false;
    }
    this.signature = signature;
    return this.adopt(this.ops.reduce((value, op) => op(value), disk));
  }

  /** Take `next` as the current value; tell listeners if it differs (i.e. someone else wrote). */
  private adopt(next: T): boolean {
    const previous = this.value;
    this.value = next;
    if (JSON.stringify(previous) === JSON.stringify(next)) return false;
    for (const listener of this.listeners) {
      try {
        listener(previous, next);
      } catch (err) {
        console.warn(`[glade] change listener for ${this.path} failed: ${(err as Error).message}`);
      }
    }
    return true;
  }

  private schedule(): void {
    if (this.debounceMs <= 0) return this.flush();
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private statSignature(): string | null {
    try {
      const s = statSync(this.path);
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {
      return null;
    }
  }

  private readDisk(): T | null {
    try {
      const signature = this.statSignature();
      const value = JSON.parse(readFileSync(this.path, "utf8")) as T;
      this.signature = signature;
      return value;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[glade] could not read ${this.path}: ${(err as Error).message}`);
      }
      return null;
    }
  }
}
