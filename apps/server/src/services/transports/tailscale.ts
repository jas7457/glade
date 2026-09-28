/**
 * The Tailscale transport (I-127; design: docs/design/environments-and-store.md §3.6).
 *
 * Uses the user's own Tailscale CLI (never a bundled one):
 * - **CLI:** `GLADE_TAILSCALE_CLI`, else `/usr/local/bin/tailscale` (Settings → CLI integration),
 *   `/opt/homebrew/bin/tailscale`, or the app's binary with `TAILSCALE_BE_CLI=1`.
 * - **Status:** `tailscale status --json` (BackendState, Self.DNSName, TailscaleIPs, CertDomains,
 *   peers) and `tailscale serve status --json`, parsed defensively.
 * - **HTTPS is required** (user decision): without CertDomains for this machine there's no
 *   plain-HTTP `100.x` fallback; Settings links to the admin console's DNS page.
 * - **On:** `tailscale serve --bg --https=443 http://127.0.0.1:<port>` (tailnet only). **Never
 *   Funnel**: if Funnel is on for `<machine>:443`, Glade refuses (running serve there would also
 *   silently remove the user's Funnel) and removes its own handler if it's behind one.
 * - **Off:** `tailscale serve --https=443 --set-path=/ off` removes only the `/` handler on 443
 *   (without `--set-path` the CLI removes every handler on the port). Other serve entries are
 *   never touched, and a `/` handler that doesn't point at a Glade port is someone else's.
 */
import { existsSync } from "node:fs";
import type { DiscoveredEnvironment, TailnetPeer, TransportProblem, TransportStatus } from "@glade/protocol";
import { execRunner, type CommandRunner, type Transport } from "./transport.js";

export const TAILSCALE_ADMIN_DNS_URL = "https://login.tailscale.com/admin/dns";
export const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download";
/** The tailnet HTTPS port Glade serves on. */
export const SERVE_PORT = 443;
const STATUS_TIMEOUT_MS = 5_000;
const SERVE_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 2_500;

export const TAILSCALE_CLI_CANDIDATES = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"] as const;
export const TAILSCALE_APP_BINARY = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export interface TailscaleCli {
  path: string;
  /** Extra environment (the app binary acts as the CLI with `TAILSCALE_BE_CLI=1`). */
  env?: Record<string, string>;
}

export type CliLookup = { cli: TailscaleCli } | { cli: null; problem: "not_installed" | "cli_not_found"; reason: string };

/** Where the Tailscale CLI is (see the header comment for the order). */
export function findTailscaleCli(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): CliLookup {
  const override = env.GLADE_TAILSCALE_CLI || env.PI_UI_TAILSCALE_CLI;
  if (override) {
    return exists(override)
      ? { cli: { path: override } }
      : { cli: null, problem: "cli_not_found", reason: `GLADE_TAILSCALE_CLI points to ${override}, which doesn't exist.` };
  }
  for (const path of TAILSCALE_CLI_CANDIDATES) if (exists(path)) return { cli: { path } };
  if (exists(TAILSCALE_APP_BINARY)) return { cli: { path: TAILSCALE_APP_BINARY, env: { TAILSCALE_BE_CLI: "1" } } };
  return { cli: null, problem: "not_installed", reason: "Tailscale isn't installed." };
}

// Parsing ----------------------------------------------------------------------------------------

export interface TailscaleNode {
  /** `<machine>.<tailnet>.ts.net`, no trailing dot. */
  dnsName?: string;
  hostName?: string;
  os?: string;
  online: boolean;
  ips: string[];
}

export interface TailscaleState {
  backendState: string;
  self: TailscaleNode | null;
  ips: string[];
  certDomains: string[];
  peers: TailscaleNode[];
}

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.length > 0) : []);
const trimDot = (name: string | undefined) => name?.replace(/\.$/, "").toLowerCase() || undefined;

function parseNode(v: unknown): TailscaleNode | null {
  const n = obj(v);
  if (!n) return null;
  return { dnsName: trimDot(str(n.DNSName)), hostName: str(n.HostName), os: str(n.OS), online: n.Online === true, ips: strings(n.TailscaleIPs) };
}

/** `tailscale status --json`, defensively (unknown shapes give empty values, never throw). */
export function parseTailscaleStatus(json: unknown): TailscaleState {
  const s = obj(json) ?? {};
  const self = parseNode(s.Self);
  const peers = Object.values(obj(s.Peer) ?? {})
    .map(parseNode)
    .filter((p): p is TailscaleNode => p !== null);
  return {
    backendState: str(s.BackendState) ?? "Unknown",
    self,
    ips: strings(s.TailscaleIPs).length ? strings(s.TailscaleIPs) : (self?.ips ?? []),
    certDomains: strings(s.CertDomains).map((d) => d.toLowerCase()),
    peers,
  };
}

export interface ServeState {
  /** The `/` handler on `<machine>:443` (background or foreground config). */
  root?: { proxy?: string };
  /** Funnel is allowed for `<machine>:443`. */
  funnel: boolean;
  /** Port 443 forwards raw TCP (not web). */
  tcpForward: boolean;
}

/** `tailscale serve status --json` for `<dnsName>:443`, including foreground sessions. */
export function parseServeConfig(json: unknown, dnsName: string, port = SERVE_PORT): ServeState {
  const out: ServeState = { funnel: false, tcpForward: false };
  const hostPort = `${dnsName}:${port}`.toLowerCase();
  const visit = (v: unknown) => {
    const sc = obj(v);
    if (!sc) return;
    for (const [key, allowed] of Object.entries(obj(sc.AllowFunnel) ?? {})) if (key.toLowerCase() === hostPort && allowed === true) out.funnel = true;
    const tcp = obj(obj(sc.TCP)?.[String(port)]);
    if (tcp && str(tcp.TCPForward)) out.tcpForward = true;
    for (const [key, web] of Object.entries(obj(sc.Web) ?? {})) {
      if (key.toLowerCase() !== hostPort) continue;
      const root = obj(obj(obj(web)?.Handlers)?.["/"]);
      if (root && !out.root) out.root = { proxy: str(root.Proxy) };
    }
    for (const fg of Object.values(obj(sc.Foreground) ?? {})) visit(fg);
  };
  visit(json);
  return out;
}

/** The loopback port a serve proxy target points at (`http://127.0.0.1:4327`), or null. */
export function loopbackProxyPort(proxy: string | undefined): number | null {
  if (!proxy) return null;
  try {
    const url = new URL(proxy);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
    if (url.pathname !== "/" || url.search) return null;
    const port = Number(url.port || 80);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export interface EvaluateInput {
  state: TailscaleState;
  serve: ServeState | null;
  /** Ports of Glade servers (this one, the others on the data folder, the last one served). */
  gladePorts: number[];
  managed: boolean;
}

export interface Evaluation {
  status: TransportStatus;
  /** The Glade port the `/` handler points at, when it's Glade's. */
  servingPort: number | null;
}

const REASONS: Record<Exclude<TransportProblem, "port_in_use" | "error">, string> = {
  not_installed: "Tailscale isn't installed.",
  cli_not_found: "Glade can't find the Tailscale command-line tool.",
  not_running: "Tailscale isn't running.",
  stopped: "Tailscale is turned off.",
  signed_out: "Tailscale is signed out.",
  https_off: "HTTPS is off in your tailnet.",
  funnel_on: "Tailscale Funnel is on for port 443, which would put Glade on the public internet.",
};

export function problemStatus(problem: TransportProblem, managed: boolean, reason?: string): TransportStatus {
  return { id: "tailscale", available: false, problem, reason: reason ?? (problem in REASONS ? REASONS[problem as keyof typeof REASONS] : "Tailscale isn't usable right now."), https: false, serving: false, managed };
}

/** Status from parsed state (pure: the tests' fixtures go through here). */
export function evaluateTailscale({ state, serve, gladePorts, managed }: EvaluateInput): Evaluation {
  const base = { id: "tailscale" as const, managed, dnsName: state.self?.dnsName, ips: state.ips.length ? state.ips : undefined };
  const fail = (problem: TransportProblem, reason?: string, https = false): Evaluation => ({
    status: { ...problemStatus(problem, managed, reason), ...base, https },
    servingPort: null,
  });
  if (state.backendState === "NeedsLogin" || state.backendState === "NeedsMachineAuth") return fail("signed_out");
  if (state.backendState === "Stopped") return fail("stopped");
  if (state.backendState !== "Running") return fail("not_running", state.backendState === "Starting" ? "Tailscale is still connecting." : undefined);
  const dnsName = state.self?.dnsName;
  if (!dnsName) return fail("https_off", "MagicDNS and HTTPS are off in your tailnet.");
  const https = state.certDomains.includes(dnsName);
  const port = loopbackProxyPort(serve?.root?.proxy);
  const servingPort = port !== null && gladePorts.includes(port) ? port : null;
  const serving = servingPort !== null;
  if (!https) return { ...fail("https_off"), servingPort };
  if (serve?.funnel) return { status: { ...fail("funnel_on", undefined, true).status, serving }, servingPort };
  if (serve?.tcpForward) return fail("port_in_use", "Port 443 on this Mac is already used by Tailscale Serve (TCP forwarding).", true);
  if (serve?.root && !serving) {
    return fail("port_in_use", `Port 443 on this Mac is already used by Tailscale Serve${serve.root.proxy ? ` (→ ${serve.root.proxy})` : ""}.`, true);
  }
  return { status: { ...base, available: true, https: true, serving }, servingPort };
}

// The transport ----------------------------------------------------------------------------------

export class TransportError extends Error {}

export interface TailscaleTransportOptions {
  /** Ports of Glade servers whose `/` handler Glade may replace or remove. */
  gladePorts: () => number[];
  /** This server manages serve (see services/transports/manager.ts). Reported in the status. */
  managed: boolean;
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  fetch?: typeof fetch;
  probeTimeoutMs?: number;
  log?: (msg: string) => void;
}

interface Snapshot {
  eval: Evaluation;
  state: TailscaleState | null;
  cli: TailscaleCli | null;
}

export class TailscaleTransport implements Transport {
  readonly id = "tailscale" as const;
  private readonly runner: CommandRunner;

  constructor(private readonly options: TailscaleTransportOptions) {
    this.runner = options.runner ?? execRunner;
  }

  async detect(): Promise<{ available: boolean; reason?: string }> {
    const { status } = (await this.snapshot()).eval;
    return status.available ? { available: true } : { available: false, reason: status.reason };
  }

  async status(): Promise<TransportStatus> {
    return (await this.snapshot()).eval.status;
  }

  async enable(port: number): Promise<TransportStatus> {
    const snap = await this.snapshot();
    const { status, servingPort } = snap.eval;
    if (!status.available || !snap.cli) throw new TransportError(status.reason ?? "Tailscale isn't available.");
    if (servingPort === port) return status;
    await this.run(snap.cli, ["serve", "--bg", `--https=${SERVE_PORT}`, `http://127.0.0.1:${port}`], "Couldn't start Tailscale Serve");
    this.options.log?.(`tailscale serve: https://${status.dnsName} → http://127.0.0.1:${port}`);
    return this.status();
  }

  async disable(): Promise<TransportStatus> {
    const snap = await this.snapshot();
    if (snap.eval.servingPort === null || !snap.cli) return snap.eval.status;
    await this.run(snap.cli, ["serve", `--https=${SERVE_PORT}`, "--set-path=/", "off"], "Couldn't stop Tailscale Serve");
    this.options.log?.(`tailscale serve: removed Glade's handler (https://${snap.eval.status.dnsName})`);
    return this.status();
  }

  async reconcile(port: number, enabled: boolean): Promise<TransportStatus> {
    const snap = await this.snapshot();
    const { status, servingPort } = snap.eval;
    // Never leave Glade behind a Funnel, whatever the switch says.
    if (servingPort !== null && (!enabled || status.problem === "funnel_on")) {
      const after = await this.disable();
      return status.problem === "funnel_on" ? { ...after, available: false, problem: "funnel_on", reason: status.reason } : after;
    }
    if (enabled && status.available && servingPort !== port) return this.enable(port);
    return status;
  }

  identify(headers: Headers): { login?: string; name?: string } | null {
    const login = headers.get("tailscale-user-login")?.trim() || undefined;
    const name = headers.get("tailscale-user-name")?.trim() || undefined;
    return login || name ? { login, name } : null;
  }

  /** Online peers, each probed at `https://<peer>/api/environment` (no token; answers while its remote access is on). */
  async discover(): Promise<DiscoveredEnvironment[]> {
    const snap = await this.snapshot();
    if (!snap.state || snap.state.backendState !== "Running") return [];
    const selfName = snap.state.self?.dnsName;
    const peers = snap.state.peers.filter((p) => p.online && p.dnsName && p.dnsName !== selfName);
    return Promise.all(peers.map((p) => this.probe(p)));
  }

  /** Peers from `tailscale status --json` only (read-only; empty when Tailscale isn't running here). */
  async peers(): Promise<TailnetPeer[]> {
    const lookup = findTailscaleCli(this.options.env ?? process.env, this.options.exists);
    if (!lookup.cli) return [];
    const out = await this.exec(lookup.cli, ["status", "--json"], STATUS_TIMEOUT_MS).catch(() => null);
    const json = out ? parseJson(out.stdout) : null;
    if (!json) return [];
    const state = parseTailscaleStatus(json);
    if (state.backendState !== "Running") return [];
    return state.peers
      .filter((p): p is TailscaleNode & { dnsName: string } => !!p.dnsName)
      .map((p) => ({ dnsName: p.dnsName, name: p.hostName ?? p.dnsName.split(".")[0]!, online: p.online, ...(p.os ? { os: p.os } : {}) }));
  }

  private async probe(peer: TailscaleNode): Promise<DiscoveredEnvironment> {
    const address = `https://${peer.dnsName}`;
    const fallback: DiscoveredEnvironment = { name: peer.hostName ?? peer.dnsName!.split(".")[0]!, address, reachable: false, ...(peer.os ? { os: peer.os } : {}) };
    try {
      const doFetch = this.options.fetch ?? fetch;
      const res = await doFetch(`${address}/api/environment`, { signal: AbortSignal.timeout(this.options.probeTimeoutMs ?? PROBE_TIMEOUT_MS), headers: { accept: "application/json" } });
      if (!res.ok) return fallback;
      const info = obj(await res.json());
      const id = str(info?.id);
      const name = str(info?.name);
      if (!id) return fallback;
      return { ...fallback, name: name ?? fallback.name, environmentId: id, reachable: true };
    } catch {
      return fallback;
    }
  }

  private async snapshot(): Promise<Snapshot> {
    const managed = this.options.managed;
    const lookup = findTailscaleCli(this.options.env ?? process.env, this.options.exists);
    if (!lookup.cli) return { eval: { status: problemStatus(lookup.problem, managed, lookup.reason), servingPort: null }, state: null, cli: null };
    const cli = lookup.cli;
    let raw: { code: number; stdout: string; stderr: string };
    try {
      raw = await this.exec(cli, ["status", "--json"], STATUS_TIMEOUT_MS);
    } catch (err) {
      return { eval: { status: problemStatus("cli_not_found", managed, `Glade can't run ${cli.path}: ${(err as Error).message}`), servingPort: null }, state: null, cli: null };
    }
    const json = parseJson(raw.stdout);
    if (!json) {
      const text = `${raw.stderr} ${raw.stdout}`.trim();
      const notRunning = /is tailscale running|failed to connect|connection refused|no such file|tailscaled/i.test(text);
      return {
        eval: { status: problemStatus(notRunning ? "not_running" : "error", managed, notRunning ? undefined : `Tailscale status failed: ${firstLine(text) || `exit ${raw.code}`}`), servingPort: null },
        state: null,
        cli,
      };
    }
    const state = parseTailscaleStatus(json);
    let serve: ServeState | null = null;
    if (state.backendState === "Running" && state.self?.dnsName) {
      try {
        const out = await this.exec(cli, ["serve", "status", "--json"], STATUS_TIMEOUT_MS);
        // An empty config prints `{}` (or nothing on older versions).
        const parsed = out.code === 0 ? (parseJson(out.stdout) ?? (out.stdout.trim() === "" ? {} : null)) : null;
        if (parsed === null) {
          return { eval: { status: { ...problemStatus("error", managed, `Couldn't read Tailscale Serve's settings: ${firstLine(out.stderr) || `exit ${out.code}`}`), dnsName: state.self.dnsName }, servingPort: null }, state, cli };
        }
        serve = parseServeConfig(parsed, state.self.dnsName);
      } catch (err) {
        return { eval: { status: problemStatus("error", managed, (err as Error).message), servingPort: null }, state, cli };
      }
    }
    return { eval: evaluateTailscale({ state, serve, gladePorts: this.options.gladePorts(), managed }), state, cli };
  }

  private exec(cli: TailscaleCli, args: string[], timeoutMs: number) {
    const env = cli.env ? { ...(this.options.env ?? process.env), ...cli.env } : undefined;
    return this.runner(cli.path, args, { env, timeoutMs });
  }

  private async run(cli: TailscaleCli, args: string[], what: string): Promise<void> {
    let out: { code: number; stdout: string; stderr: string };
    try {
      out = await this.exec(cli, args, SERVE_TIMEOUT_MS);
    } catch (err) {
      throw new TransportError(`${what}: ${(err as Error).message}`);
    }
    if (out.code !== 0) throw new TransportError(`${what}: ${firstLine(out.stderr || out.stdout) || `exit ${out.code}`}`);
  }
}

function parseJson(text: string): unknown {
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === "object" && v !== null ? v : null;
  } catch {
    return null;
  }
}

function firstLine(text: string): string {
  return text.trim().split("\n").find((l) => l.trim())?.trim() ?? "";
}
