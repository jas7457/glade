/**
 * One ACP agent process (I-119): spawns the configured command with stdio pipes and speaks ACP
 * (newline-delimited JSON-RPC) over them with the official SDK (`@agentclientprotocol/sdk`).
 * The agent's calls into the client (session updates, permission requests, file access) go to
 * the {@link AcpClientHandlers} of the session that owns the process.
 *
 * Only the methods Glade implements are registered; anything else (terminals, elicitation)
 * answers "method not found", matching the capabilities Glade advertises in `initialize`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client,
  ndJsonStream,
  type ClientConnection,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
} from "@agentclientprotocol/sdk";

export interface AcpClientHandlers {
  sessionUpdate(params: SessionNotification): void;
  requestPermission(params: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>;
  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile(params: WriteTextFileRequest): Promise<void>;
}

export interface AcpProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  handlers: AcpClientHandlers;
  log?: (msg: string) => void;
}

/** Keep this much of the agent's stderr for error messages. */
const STDERR_TAIL = 4000;

export class AcpProcess {
  readonly connection: ClientConnection;
  private readonly child: ChildProcessWithoutNullStreams;
  private stderr = "";
  private exited = false;
  /** We stopped it (`kill`): its exit isn't an error. */
  private killed = false;
  private exitListeners = new Set<(error: Error | null) => void>();
  /** Set when the process couldn't be started (e.g. the command wasn't found). */
  private spawnError: Error | null = null;

  constructor(private readonly options: AcpProcessOptions) {
    const { command, args, cwd, env, handlers } = options;
    this.child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.on("error", () => {}); // EPIPE after the agent died; the exit handler reports it
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
    });
    this.child.on("error", (err: NodeJS.ErrnoException) => {
      this.spawnError =
        err.code === "ENOENT" ? new Error(`Could not start \`${command}\`: command not found (check the agent's command in Settings → Agents)`) : err;
      this.finish(this.spawnError);
    });
    this.child.on("exit", (code, signal) => {
      if (code === 0 || this.killed) return this.finish(null);
      const tail = this.stderr.trim().split("\n").slice(-5).join("\n");
      this.finish(new Error(`The agent exited (${signal ?? `code ${code}`})${tail ? `: ${tail}` : ""}`));
    });

    const stream = ndJsonStream(
      Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    this.connection = client({ name: "glade" })
      .onNotification("session/update", (ctx) => handlers.sessionUpdate(ctx.params))
      .onRequest("session/request_permission", (ctx) => handlers.requestPermission(ctx.params, ctx.signal))
      .onRequest("fs/read_text_file", (ctx) => handlers.readTextFile(ctx.params))
      .onRequest("fs/write_text_file", async (ctx) => {
        await handlers.writeTextFile(ctx.params);
        return {};
      })
      .connect(stream);
    // The connection rejects pending requests when it closes; nothing else to do here.
    this.connection.closed.catch(() => {});
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** The agent's recent stderr (for error messages). */
  stderrTail(): string {
    return this.stderr;
  }

  /** Resolves once the process is gone, with its error (`null` = clean exit or killed by us). */
  readonly whenExited: Promise<Error | null> = new Promise((resolve) => this.exitListeners.add(resolve));

  /** Called once when the process is gone (`null` = clean exit or killed by us). */
  onExit(listener: (error: Error | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  get alive(): boolean {
    return !this.exited;
  }

  private finish(error: Error | null): void {
    if (this.exited) return;
    this.exited = true;
    try {
      this.connection?.close(error ?? undefined);
    } catch {
      /* already closed */
    }
    for (const listener of [...this.exitListeners]) listener(error);
    this.exitListeners.clear();
  }

  /** Stop the agent: SIGTERM, then SIGKILL if it's still there after `graceMs`. */
  async kill(graceMs = 2000): Promise<void> {
    if (this.exited) return;
    this.killed = true;
    const gone = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    try {
      this.connection.close();
    } catch {
      /* already closed */
    }
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), graceMs);
    timer.unref();
    await Promise.race([gone, new Promise((r) => setTimeout(r, graceMs + 500).unref())]);
    clearTimeout(timer);
    this.finish(null);
  }
}
