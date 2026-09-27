/**
 * Picks up changes other processes make to the shared JSON files of a data folder (I-062): an
 * `fs.watch` on the folder (FSEvents on macOS; watching the files themselves breaks on atomic
 * renames) triggers `JsonFile.reload()` for the file that changed, and a slow poll catches
 * anything the watcher misses. Reloading an unchanged file costs one `stat`.
 */
import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { basename } from "node:path";

/** What the watcher needs from a file (a `JsonFile`). */
export interface Reloadable {
  readonly path: string;
  reload(): boolean;
}

export interface DataDirWatcherOptions {
  /** Coalesce bursts of events per file (default 25ms). */
  debounceMs?: number;
  /** Safety-net poll of every file (default 2000ms; 0 = off). */
  pollMs?: number;
}

export class DataDirWatcher {
  /** basename -> file */
  private readonly files = new Map<string, Reloadable>();
  private watcher: FSWatcher | null = null;
  private poll: NodeJS.Timeout | null = null;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly dir: string,
    private readonly options: DataDirWatcherOptions = {},
  ) {}

  add(file: Reloadable): void {
    this.files.set(basename(file.path), file);
  }

  start(): void {
    if (this.watcher || this.poll) return;
    mkdirSync(this.dir, { recursive: true });
    try {
      this.watcher = watch(this.dir, (_event, name) => {
        const file = name ? this.files.get(basename(name.toString())) : undefined;
        if (file) this.schedule(file);
      });
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = null; // the poll keeps working
      });
      this.watcher.unref();
    } catch {
      // No watcher (unsupported filesystem): the poll still picks changes up.
    }
    const pollMs = this.options.pollMs ?? 2000;
    if (pollMs > 0) {
      this.poll = setInterval(() => this.checkAll(), pollMs);
      this.poll.unref();
    }
  }

  /** Reload every file now (tests, and the poll). */
  checkAll(): void {
    for (const file of this.files.values()) file.reload();
  }

  private schedule(file: Reloadable): void {
    const key = file.path;
    if (this.timers.has(key)) return;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      file.reload();
    }, this.options.debounceMs ?? 25);
    timer.unref();
    this.timers.set(key, timer);
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
