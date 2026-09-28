/**
 * Pluggable transports for remote access (I-127; design: docs/design/environments-and-store.md
 * §3.6). A transport makes this server reachable by paired devices without opening a port to
 * the internet. Tailscale is the first (services/transports/tailscale.ts); a LAN or tunnel one
 * could follow. The transport only moves bytes: pairing and device tokens (services/auth) stay
 * the security boundary.
 *
 * External commands go through a {@link CommandRunner} so tests never run the real CLI.
 */
import { execFile } from "node:child_process";
import type { DiscoveredEnvironment, TransportStatus } from "@glade/protocol";

export interface Transport {
  readonly id: TransportStatus["id"];
  /** Can it be used at all (installed, running, signed in…)? */
  detect(): Promise<{ available: boolean; reason?: string }>;
  /** Full status, read fresh. */
  status(): Promise<TransportStatus>;
  /** Route the transport to this server's loopback `port`. Throws with a user-facing message. */
  enable(port: number): Promise<TransportStatus>;
  /** Remove only Glade's own configuration. */
  disable(): Promise<TransportStatus>;
  /** At startup and when the switch changes: point at `port` when enabled, remove stale config when not. */
  reconcile(port: number, enabled: boolean): Promise<TransportStatus>;
  /** Who a proxied request says it is (a hint for the host's confirm prompt, never trusted). */
  identify?(headers: Headers): { login?: string; name?: string } | null;
  /** Other machines on the network that run Glade. */
  discover?(): Promise<DiscoveredEnvironment[]>;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `file args…` and resolves with its output (non-zero exits resolve too). Rejects when it can't start. */
export type CommandRunner = (file: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<CommandResult>;

/** The real runner (`execFile`, no shell). */
export const execRunner: CommandRunner = (file, args, { env, timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env: env ?? process.env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      // ENOENT/EACCES…: the command couldn't start.
      if (err && typeof (err as NodeJS.ErrnoException).code === "string") return reject(err);
      if (err && (err as { killed?: boolean }).killed) return resolve({ code: 124, stdout: String(stdout), stderr: String(stderr) || "timed out" });
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
