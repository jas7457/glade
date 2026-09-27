/**
 * A short, synchronous, cross-process lock for one file (I-062). Several pi-ui servers (e.g.
 * `pnpm dev` and the installed app) share a data folder; every read-modify-write of a shared JSON
 * file runs inside {@link withFileLock} so no server writes over another's change.
 *
 * The lock is a directory `<path>.lock` (mkdir is atomic on every filesystem we care about).
 * Holders keep it for a few milliseconds (read, apply, write, rename), so a lock older than
 * {@link STALE_LOCK_MS} was left behind by a crashed process and is broken. Waiting is a sync
 * sleep (`Atomics.wait`): all store operations are synchronous and the wait is tiny.
 */
import { mkdirSync, rmdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** A lock older than this is considered abandoned (a holder crashed mid-write). */
export const STALE_LOCK_MS = 5_000;
/** Give up waiting (and break the lock) after this long; should never happen in practice. */
const MAX_WAIT_MS = 10_000;

const sleeper = new Int32Array(new SharedArrayBuffer(4));
export function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

export function lockPathFor(path: string): string {
  return `${path}.lock`;
}

/** Run `fn` while holding `<path>.lock`. Re-entrant use for the same path would deadlock; don't. */
export function withFileLock<T>(path: string, fn: () => T): T {
  const lock = lockPathFor(path);
  const started = Date.now();
  let delay = 1;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        mkdirSync(dirname(lock), { recursive: true });
        continue;
      }
      if (code !== "EEXIST") throw err;
    }
    let age = 0;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      continue; // released meanwhile
    }
    if (age > STALE_LOCK_MS || Date.now() - started > MAX_WAIT_MS) {
      breakLock(lock);
      continue;
    }
    sleepSync(delay);
    delay = Math.min(delay * 2, 20);
  }
  try {
    return fn();
  } finally {
    breakLock(lock);
  }
}

function breakLock(lock: string): void {
  try {
    rmdirSync(lock);
  } catch {
    /* already gone */
  }
}
