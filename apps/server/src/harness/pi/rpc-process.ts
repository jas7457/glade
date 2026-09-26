import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { EventEmitter } from "node:events";

/**
 * Splits a byte stream into JSONL records. pi's RPC framing is strict LF-delimited JSONL, so we
 * must NOT use `readline` (it also splits on U+2028/U+2029, which are valid inside JSON strings).
 */
export class JsonlSplitter {
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let start = 0;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n", start)) !== -1) {
      let line = this.buffer.slice(start, idx);
      start = idx + 1;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) this.onLine(line);
    }
    if (start > 0) this.buffer = this.buffer.slice(start);
  }

  end(): void {
    this.buffer += this.decoder.end();
    const rest = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
    this.buffer = "";
    if (rest.length > 0) this.onLine(rest);
  }
}

export interface RpcProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Default timeout for request/response commands. */
  requestTimeoutMs?: number;
}

export interface PiRpcResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * A single `pi --mode rpc` child process with request/response correlation.
 * Emits `event` for every non-response record, `stderr` for diagnostic output, and `exit`.
 */
export class PiRpcProcess extends EventEmitter<{
  event: [Record<string, unknown>];
  stderr: [string];
  exit: [code: number | null, signal: NodeJS.Signals | null];
}> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private exited = false;
  private stderrTail = "";

  constructor(private readonly options: RpcProcessOptions) {
    super();
  }

  start(): void {
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    const splitter = new JsonlSplitter((line) => this.handleLine(line));
    child.stdout.on("data", (chunk: Buffer) => splitter.push(chunk));
    child.stdout.on("end", () => splitter.end());
    // Writing to a process that failed to spawn / already died raises EPIPE on stdin; without a
    // listener that would crash the whole server. The exit handler reports the failure instead.
    child.stdin.on("error", (err) => this.emit("stderr", `[stdin] ${err.message}\n`));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrTail = (this.stderrTail + text).slice(-4000);
      this.emit("stderr", text);
    });
    child.on("error", (err) => this.handleExit(err, null, null));
    child.on("exit", (code, signal) => this.handleExit(null, code, signal));
  }

  get isAlive(): boolean {
    return !!this.child && !this.exited;
  }

  /** Last stderr output, useful for error messages when the process dies. */
  get recentStderr(): string {
    return this.stderrTail.trim();
  }

  /** Send a command and wait for its response `data`. Rejects on `success: false`. */
  request<T = unknown>(command: Record<string, unknown> & { type: string }, timeoutMs?: number): Promise<T> {
    if (!this.isAlive) return Promise.reject(new Error("pi process is not running"));
    const id = `req-${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi command "${command.type}" timed out`));
      }, timeoutMs ?? this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve: resolve as (d: unknown) => void, reject, timer });
      this.write({ ...command, id });
    });
  }

  /** Fire-and-forget write (e.g. extension UI responses). */
  write(record: Record<string, unknown>): void {
    if (!this.child || this.exited) return;
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  /** Stop the process. Resolves once it has exited (SIGKILL after 3s if it ignores SIGTERM). */
  kill(): Promise<void> {
    if (!this.child || this.exited) return Promise.resolve();
    const child = this.child;
    const exited = new Promise<void>((resolve) => this.once("exit", () => resolve()));
    child.stdin.end();
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (!this.exited) child.kill("SIGKILL");
    }, 3000);
    timer.unref();
    return exited.finally(() => clearTimeout(timer));
  }

  private handleLine(line: string): void {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emit("stderr", `[non-JSON stdout] ${line}\n`);
      return;
    }
    if (record.type === "response") {
      const response = record as unknown as PiRpcResponse;
      const pending = response.id ? this.pending.get(response.id) : undefined;
      if (pending) {
        this.pending.delete(response.id!);
        clearTimeout(pending.timer);
        if (response.success) pending.resolve(response.data);
        else pending.reject(new Error(response.error ?? `pi command "${response.command}" failed`));
        return;
      }
    }
    this.emit("event", record);
  }

  private handleExit(err: Error | null, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    const reason = err ?? new Error(`pi exited (code ${code ?? "?"}${signal ? `, ${signal}` : ""})`);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
      this.pending.delete(id);
    }
    this.emit("exit", code, signal);
  }
}
