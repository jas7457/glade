/**
 * JSON-RPC with `codex app-server` (I-177): requests with ids and replies, notifications, and
 * requests *from* Codex (approvals, questions, Glade's tools) answered by a handler.
 *
 * - {@link CodexTransport} is the wire: {@link spawnCodexTransport} starts the user's
 *   `codex app-server` and frames its stdio as JSONL (strict LF, like pi's RPC: not `readline`);
 *   tests inject a scripted fake (`test/fixtures/fake-codex-app-server.ts`).
 * - {@link CodexRpc} correlates replies, times out requests, rejects everything pending when the
 *   process ends, and answers server requests with the handler's result (or a JSON-RPC error).
 */
import { spawn } from "node:child_process";
import { JsonlSplitter } from "../pi/rpc-process.js";
import type { RequestId, RpcMessage } from "./protocol.js";

/** The line-level wire to one app-server. */
export interface CodexTransport {
  send(message: RpcMessage): void;
  onMessage(listener: (message: RpcMessage) => void): void;
  /** Called once when the process ends (`error` null when it exited on its own with code 0). */
  onClose(listener: (error: Error | null) => void): void;
  close(): void;
}

export interface SpawnCodexOptions {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Extra arguments after `app-server` (tests). */
  args?: string[];
}

/** `codex app-server` over stdio. */
export function spawnCodexTransport({ executable, cwd, env, args = [] }: SpawnCodexOptions): CodexTransport {
  const child = spawn(executable, ["app-server", ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const listeners: Array<(m: RpcMessage) => void> = [];
  const closers: Array<(e: Error | null) => void> = [];
  let stderr = "";
  let closed = false;
  const close = (error: Error | null) => {
    if (closed) return;
    closed = true;
    for (const c of closers) c(error);
  };
  const splitter = new JsonlSplitter((line) => {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return; // not a protocol line
    }
    for (const l of listeners) l(message);
  });
  child.stdout.on("data", (chunk: Buffer) => splitter.push(chunk));
  child.stdout.on("end", () => splitter.end());
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });
  child.stdin.on("error", () => {}); // EPIPE after exit: reported by `exit`
  child.on("error", (err) => close(err));
  child.on("exit", (code, signal) => {
    const tail = stderr.trim().split("\n").slice(-5).join("\n");
    close(code === 0 && !signal ? null : new Error(`codex app-server exited (${signal ?? `code ${code}`})${tail ? `: ${tail}` : ""}`));
  });
  return {
    send(message) {
      if (closed || !child.stdin.writable) return;
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onMessage: (l) => void listeners.push(l),
    onClose: (l) => void closers.push(l),
    close() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    },
  };
}

/** A JSON-RPC error from Codex (`code`, `message`). */
export class CodexRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export type NotificationHandler = (method: string, params: unknown) => void;
/** Answers a request from Codex; a thrown error becomes a JSON-RPC error reply. */
export type ServerRequestHandler = (method: string, params: unknown, id: RequestId) => Promise<unknown>;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | undefined;
  method: string;
}

export class CodexRpc {
  private nextId = 1;
  private readonly pending = new Map<RequestId, Pending>();
  private closedWith: Error | null | undefined = undefined;
  private readonly closeListeners: Array<(error: Error | null) => void> = [];

  constructor(
    private readonly transport: CodexTransport,
    private readonly handlers: { notification: NotificationHandler; request: ServerRequestHandler },
    private readonly requestTimeoutMs = 60_000,
  ) {
    transport.onMessage((m) => this.onMessage(m));
    transport.onClose((error) => this.handleClose(error));
  }

  get closed(): boolean {
    return this.closedWith !== undefined;
  }

  onClose(listener: (error: Error | null) => void): void {
    this.closeListeners.push(listener);
  }

  request<T>(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (this.closedWith !== undefined) return Promise.reject(this.closedWith ?? new Error("codex app-server has exited"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`codex app-server didn't answer ${method} in time`));
            }, timeoutMs)
          : undefined;
      timer?.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      this.transport.send({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closedWith !== undefined) return;
    this.transport.send({ method, ...(params === undefined ? {} : { params }) });
  }

  close(): void {
    this.transport.close();
  }

  private onMessage(message: RpcMessage): void {
    if (message.method !== undefined && message.id !== undefined) {
      const { id, method } = message;
      void this.handlers.request(method, message.params, id).then(
        (result) => this.transport.send({ id, result: result ?? {} }),
        (err: Error) => this.transport.send({ id, error: { code: err instanceof CodexRpcError ? err.code : -32603, message: err.message } }),
      );
      return;
    }
    if (message.method !== undefined) {
      this.handlers.notification(message.method, message.params);
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.error) pending.reject(new CodexRpcError(message.error.message, message.error.code, message.error.data));
    else pending.resolve(message.result);
  }

  private handleClose(error: Error | null): void {
    if (this.closedWith !== undefined) return;
    this.closedWith = error;
    const reason = error ?? new Error("codex app-server has exited");
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      p.reject(reason);
    }
    for (const l of this.closeListeners) l(error);
  }
}
