/**
 * Keeping the Mac awake (I-147) and the desktop shell's menu bar state (I-150).
 *
 * `PowerTracker` recomputes, whenever something relevant changes, why the Mac should stay awake
 * (`computeAwakeReasons` in @glade/protocol: chats working on this server; sharing on with a
 * device connected, per `Settings.power` and the power source) plus the counts the menu bar shows,
 * and bumps a revision. Consumers:
 * - `GET /api/power` and the `power` push to local-owner sockets (Settings → General / Remote
 *   Access show "Keeping this device awake: …");
 * - `GET /api/desktop/state?after=<rev>`, a long-poll the Mac app's shell uses to hold/release its
 *   IOKit assertion and update the menu bar icon (src-tauri/src/shell_state.rs).
 *
 * Only the Mac app's server (`canHold`) reports `held`; a web-only `pnpm dev` holds nothing.
 * Triggers: app pushes (session/workspace/settings changes), remote sockets opening/closing, and
 * a slow tick for things without pushes (the remote switch flipped by another server, the power
 * source, sessions another server runs).
 */
import { execFile } from "node:child_process";
import {
  awakeReasonText,
  computeAwakeReasons,
  needsAttention,
  type DesktopShellState,
  type PowerSource,
  type PowerStatus,
  type ServerMessage,
  type SessionSummary,
  type Settings,
  type WorkspaceSummary,
} from "@glade/protocol";

export interface PowerTrackerOptions {
  sessions: () => SessionSummary[];
  workspaces: () => WorkspaceSummary[];
  settings: () => Settings;
  /** Sharing (host + master switch) is on. */
  sharingOn: () => boolean;
  /** Names of devices with a socket open now. */
  connectedDevices: () => string[];
  /** This server is the Mac app's (it holds the assertion). */
  canHold: boolean;
  /** Where the power comes from; default: `pmset -g batt` on macOS, null elsewhere. */
  powerSource?: () => Promise<PowerSource | null>;
  /** Recheck interval for changes without pushes. Default 2 s; 0 = no timer (tests). */
  tickMs?: number;
  /** How long a cached power source is trusted. Default 30 s. */
  powerSourceTtlMs?: number;
  now?: () => number;
}

type ChangeListener = (state: DesktopShellState) => void;

/** Pushes from the app that can change the state (streaming `session_event`s can't). */
const RELEVANT: ReadonlySet<ServerMessage["type"]> = new Set([
  "session_upsert",
  "session_removed",
  "workspace_upsert",
  "workspace_removed",
  "settings",
  "snapshot",
]);

export function isRelevantMessage(message: ServerMessage): boolean {
  if (message.type === "batch") return message.messages.some(isRelevantMessage);
  return RELEVANT.has(message.type);
}

export class PowerTracker {
  private state: DesktopShellState;
  private key = "";
  private readonly listeners = new Set<ChangeListener>();
  private readonly waiters = new Set<() => void>();
  private timer: NodeJS.Timeout | null = null;
  private scheduled: NodeJS.Timeout | null = null;
  private source: PowerSource | null = null;
  private sourceAt = -Infinity;
  private sourceLoading = false;
  private readonly now: () => number;
  private readonly readPowerSource: () => Promise<PowerSource | null>;
  private disposed = false;

  constructor(private readonly options: PowerTrackerOptions) {
    this.now = options.now ?? Date.now;
    this.readPowerSource = options.powerSource ?? defaultPowerSource;
    this.state = { rev: 0, ...this.compute() };
    this.key = stateKey(this.state);
    const tickMs = options.tickMs ?? 2000;
    if (tickMs > 0) {
      this.timer = setInterval(() => this.refresh(), tickMs);
      this.timer.unref();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.scheduled) clearTimeout(this.scheduled);
    this.timer = this.scheduled = null;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  current(): DesktopShellState {
    return this.state;
  }

  power(): PowerStatus {
    return this.state.power;
  }

  /** Called with the new state after every change. Returns an unsubscribe function. */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** An app push arrived: recompute soon (coalesced) if it can matter. */
  onMessage(message: ServerMessage): void {
    if (isRelevantMessage(message)) this.schedule();
  }

  /** Recompute soon (coalesces bursts, e.g. a run starting in several sessions). */
  schedule(): void {
    if (this.scheduled || this.disposed) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      this.refresh();
    }, 30);
    this.scheduled.unref?.();
  }

  /** Recompute now; bumps `rev` and notifies when anything changed. */
  refresh(): DesktopShellState {
    if (this.disposed) return this.state;
    const next = this.compute();
    const key = stateKey({ rev: 0, ...next });
    if (key !== this.key) {
      this.key = key;
      this.state = { rev: this.state.rev + 1, ...next };
      for (const wake of this.waiters) wake();
      this.waiters.clear();
      for (const listener of this.listeners) listener(this.state);
    }
    return this.state;
  }

  /**
   * Long-poll: the current state at once when its rev isn't `after`, else the next change or the
   * current state after `timeoutMs` (or when `signal` aborts).
   */
  async wait(after: number | null, timeoutMs = 25_000, signal?: AbortSignal): Promise<DesktopShellState> {
    if (after === null || after !== this.state.rev || this.disposed) return this.state;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      this.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
    return this.state;
  }

  private compute(): Omit<DesktopShellState, "rev"> {
    const { options } = this;
    const sessions = options.sessions();
    const workingHere = new Set<string>();
    for (const s of sessions) if (s.running && !s.activeElsewhere) workingHere.add(s.workspaceId);
    let working = 0;
    let needsYou = 0;
    for (const w of options.workspaces()) {
      if (w.status === "working") working++;
      if (needsAttention(w.status)) needsYou++;
    }
    const sharingOn = options.sharingOn();
    const devices = sharingOn ? options.connectedDevices() : [];
    // The power source only matters while a shared device is connected.
    if (devices.length) this.ensurePowerSource();
    const settings = options.settings().power;
    const { reasons, sharedSkipped } = computeAwakeReasons({
      workingChats: workingHere.size,
      sharingOn,
      connectedDevices: devices,
      powerSource: devices.length ? this.source : null,
      settings,
    });
    return {
      chats: { working, needsYou },
      sharing: { on: sharingOn, devices },
      power: {
        reasons,
        text: awakeReasonText(reasons),
        held: options.canHold && reasons.length > 0,
        canHold: options.canHold,
        powerSource: devices.length ? this.source : null,
        sharedSkipped,
      },
    };
  }

  /** Refresh the cached power source in the background when it's stale; recompute when it changes. */
  private ensurePowerSource(): void {
    const ttl = this.options.powerSourceTtlMs ?? 30_000;
    if (this.sourceLoading || this.now() - this.sourceAt < ttl) return;
    this.sourceLoading = true;
    void this.readPowerSource()
      .catch(() => null)
      .then((source) => {
        this.sourceLoading = false;
        this.sourceAt = this.now();
        if (source !== this.source) {
          this.source = source;
          this.schedule();
        }
      });
  }
}

function stateKey(state: DesktopShellState): string {
  return JSON.stringify({ ...state, rev: 0 });
}

/** `pmset -g batt` (read-only): "Now drawing from 'AC Power'" / "'Battery Power'". */
export function parsePmsetBatt(output: string): PowerSource | null {
  const m = /drawing from '([^']+)'/.exec(output);
  if (!m) return null;
  if (/battery/i.test(m[1]!)) return "battery";
  if (/ac/i.test(m[1]!)) return "ac";
  return null;
}

function defaultPowerSource(): Promise<PowerSource | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("/usr/bin/pmset", ["-g", "batt"], { timeout: 3000 }, (err, stdout) => resolve(err ? null : parsePmsetBatt(String(stdout))));
  });
}

/** What {@link createPowerTracker} needs from the app and the auth service. */
export interface PowerWiring {
  service: {
    listSessions(): SessionSummary[];
    listWorkspaces(): WorkspaceSummary[];
    getSettings(): Settings;
    subscribe(listener: (message: ServerMessage) => void, options?: { internal?: boolean }): () => void;
  };
  auth: {
    isRemoteEnabled(): boolean;
    connectedDeviceNames(): string[];
    onSocketsChange(listener: () => void): () => void;
    pushLocal(message: ServerMessage): void;
  };
  canHold: boolean;
  tickMs?: number;
  powerSource?: () => Promise<PowerSource | null>;
}

/**
 * A tracker wired to the app (pushes, sessions, settings) and the auth service (sharing,
 * connected devices), pushing `power` to local-owner sockets when the status changes.
 * `dispose()` unhooks everything.
 */
export function createPowerTracker({ service, auth, canHold, tickMs, powerSource }: PowerWiring): PowerTracker {
  const tracker = new PowerTracker({
    sessions: () => service.listSessions(),
    workspaces: () => service.listWorkspaces(),
    settings: () => service.getSettings(),
    sharingOn: () => auth.isRemoteEnabled(),
    connectedDevices: () => auth.connectedDeviceNames(),
    canHold,
    tickMs,
    powerSource,
  });
  const offs = [
    service.subscribe((message) => tracker.onMessage(message), { internal: true }),
    auth.onSocketsChange(() => tracker.schedule()),
  ];
  let lastPower = JSON.stringify(tracker.power());
  offs.push(
    tracker.onChange((state) => {
      const key = JSON.stringify(state.power);
      if (key === lastPower) return;
      lastPower = key;
      auth.pushLocal({ type: "power", power: state.power });
    }),
  );
  const dispose = tracker.dispose.bind(tracker);
  tracker.dispose = () => {
    for (const off of offs) off();
    dispose();
  };
  return tracker;
}
