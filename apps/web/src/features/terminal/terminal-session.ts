/**
 * One terminal tab's connection (I-187), independent of Preact and xterm.js so it can be tested
 * with fakes: it attaches to the shell over `/ws/terminal/:id`, replays the scrollback snapshot,
 * streams output into the terminal and keystrokes/resizes back, and tracks the tab's state:
 *
 *   connecting → live ⇄ exited ("[Process exited with code N]", Restart)
 *              → ended (the server has no such shell any more: it restarted, or another server
 *                runs it; "Session ended", New Session)
 *
 * A dropped socket reconnects with backoff (the snapshot replaces what's on screen, so nothing is
 * duplicated). Restart / New Session start the shell over REST and reconnect when needed.
 */
import { signal } from "@preact/signals";
import { TERMINAL_MISSING_CLOSE_CODE, type TerminalExit, type TerminalInfo, type TerminalServerMessage, type StartTerminalRequest } from "@glade/protocol";

/** What the session needs from the terminal widget (xterm.js in the app, a fake in tests). */
export interface TerminalScreen {
  readonly cols: number;
  readonly rows: number;
  write(data: string): void;
  reset(): void;
}

export type TerminalStatus = "connecting" | "live" | "exited" | "ended" | "error";

export interface TerminalSessionOptions {
  screen: TerminalScreen;
  socketUrl: () => Promise<string>;
  start: (size: StartTerminalRequest) => Promise<TerminalInfo>;
  /** Injectable for tests. */
  WebSocketImpl?: new (url: string) => WebSocket;
  /** Reconnect delays (ms), the last one repeats. */
  backoffMs?: readonly number[];
}

const OPEN = 1;
const DEFAULT_BACKOFF = [500, 1000, 2000, 5000];

/** The line written when the shell exits. */
export function exitLine(exit: TerminalExit): string {
  // Dimmed, and the cursor hidden until a restart shows it again.
  return `\r\n\x1b[2m[Process exited with code ${exit.code}]\x1b[0m\r\n\x1b[?25l`;
}

export class TerminalSession {
  readonly status = signal<TerminalStatus>("connecting");
  readonly exit = signal<TerminalExit | null>(null);
  readonly error = signal<string | null>(null);
  readonly info = signal<TerminalInfo | null>(null);

  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private starting = false;

  constructor(private readonly options: TerminalSessionOptions) {}

  /** Attach to the running shell. */
  connect(): void {
    if (this.disposed) return;
    this.clearTimer();
    this.closeSocket();
    this.status.value = this.status.value === "ended" ? "ended" : "connecting";
    const attempt = ++this.attempt;
    this.options.socketUrl().then(
      (url) => {
        if (this.disposed || attempt !== this.attempt) return;
        this.open(url, attempt);
      },
      (err: Error & { status?: number }) => {
        if (this.disposed || attempt !== this.attempt) return;
        if (err.status === 401 || err.status === 403) return this.fail(err.message);
        this.scheduleReconnect();
      },
    );
  }

  /** Keystrokes and pastes from the terminal. */
  input(data: string): void {
    if (this.status.value === "live") this.send({ type: "input", data });
  }

  /** The terminal was resized (cols × rows). */
  resize(cols: number, rows: number): void {
    if (this.status.value === "live") this.send({ type: "resize", cols, rows });
  }

  /** Restart after an exit, or start a new shell after "Session ended". */
  async restart(): Promise<void> {
    if (this.starting || this.disposed) return;
    this.starting = true;
    this.error.value = null;
    try {
      const { cols, rows } = this.options.screen;
      const info = await this.options.start({ cols, rows });
      if (this.disposed) return;
      this.info.value = info;
      // A live socket gets `started` from the server; otherwise attach now.
      if (!this.ws || this.ws.readyState !== OPEN || this.status.value === "ended") {
        this.status.value = "connecting";
        this.connect();
      }
    } catch (err) {
      this.error.value = (err as Error).message;
    } finally {
      this.starting = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.closeSocket();
  }

  private open(url: string, attempt: number): void {
    const Impl = this.options.WebSocketImpl ?? WebSocket;
    const ws = new Impl(url);
    this.ws = ws;
    ws.onmessage = (event: MessageEvent) => {
      if (attempt !== this.attempt) return;
      let message: TerminalServerMessage;
      try {
        message = JSON.parse(String(event.data)) as TerminalServerMessage;
      } catch {
        return;
      }
      this.onMessage(message);
    };
    ws.onclose = (event: CloseEvent) => {
      if (this.disposed || attempt !== this.attempt) return;
      this.ws = null;
      if (event.code === TERMINAL_MISSING_CLOSE_CODE) {
        this.status.value = "ended";
        return;
      }
      this.scheduleReconnect();
    };
  }

  private onMessage(message: TerminalServerMessage): void {
    const { screen } = this.options;
    switch (message.type) {
      case "snapshot":
        this.attemptReset();
        screen.reset();
        screen.write(message.data);
        this.info.value = message.info;
        if (message.info.exit) this.markExited(message.info.exit);
        else {
          this.exit.value = null;
          this.status.value = "live";
          // Our size wins (the shell redraws for it).
          this.resize(screen.cols, screen.rows);
        }
        return;
      case "output":
        screen.write(message.data);
        return;
      case "exit":
        this.markExited(message.exit);
        return;
      case "started":
        screen.write("\x1b[?25h");
        this.info.value = message.info;
        this.exit.value = null;
        this.status.value = "live";
        this.resize(screen.cols, screen.rows);
        return;
    }
  }

  private markExited(exit: TerminalExit): void {
    this.options.screen.write(exitLine(exit));
    this.exit.value = exit;
    this.status.value = "exited";
  }

  private send(message: { type: "input"; data: string } | { type: "resize"; cols: number; rows: number }): void {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(message));
  }

  private fail(message: string): void {
    this.error.value = message;
    this.status.value = "error";
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.status.value !== "ended") this.status.value = "connecting";
    const delays = this.options.backoffMs ?? DEFAULT_BACKOFF;
    const delay = delays[Math.min(this.failures++, delays.length - 1)] ?? 1000;
    this.timer = setTimeout(() => this.connect(), delay);
  }

  /** Consecutive failed connects (reset by a snapshot). */
  private failures = 0;
  private attemptReset(): void {
    this.failures = 0;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onmessage = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
}
