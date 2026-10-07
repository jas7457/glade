/**
 * Agent versions and updates (I-198): per environment (each Mac checks and updates its own agents),
 * which version of pi / Claude Code / Codex is installed, the newest one, and the update job.
 *
 * Fed by the API answers and, for this device's own server, its `agent_versions` push (local-owner
 * sockets only). Another Mac's status (picked in the device switcher) doesn't push to us, so it's
 * polled while a check or an update runs there.
 *
 *   startAgentVersionsSync()                // once at startup: local push + a load (for the dot)
 *   agentVersionOf(envId, "claude")         // AgentVersionInfo | null
 *   agentsBehind(envId).value               // how many agents have a newer version
 *   await checkAgentVersions(envId, true)   // Check Now
 *   await updateAgent(envId, "claude")      // Update (starts now or when its chats finish)
 *
 * Portable client core (F-022).
 */
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import type { AgentVersionInfo, AgentVersionsStatus, ServerMessage } from "@glade/protocol";
import * as apiAgentVersions from "@glade/app-core/lib/api-agent-versions";
import { request, type RequestFn } from "@glade/app-core/lib/api";
import { socket as localSocket, type Socket } from "@glade/app-core/lib/socket";
import { isLocalEnvironment } from "./env-registry";
import { requestFor } from "./env-api";

/** Status per environment ({@link agentVersionsKey}). */
export const agentVersions = signal<ReadonlyMap<string, AgentVersionsStatus>>(new Map());
/** Why the last load/check failed, per environment (e.g. an older Glade without the API). */
export const agentVersionsError = signal<ReadonlyMap<string, string>>(new Map());
/** Environments with a Check Now in flight (the button's spinner). */
export const agentVersionsChecking = signal<ReadonlySet<string>>(new Set());
/** Why the last Update/Cancel failed, per `${key}\n${harness}`. */
export const agentUpdateErrors = signal<ReadonlyMap<string, string>>(new Map());

/** Map key of an environment: "" for this device's own server (also untagged), else its id. */
export function agentVersionsKey(envId: string | null | undefined): string {
  return !envId || isLocalEnvironment(envId) ? "" : envId;
}

export function agentVersionsOf(envId: string | null | undefined): AgentVersionsStatus | null {
  return agentVersions.value.get(agentVersionsKey(envId)) ?? null;
}

export function agentVersionOf(envId: string | null | undefined, harness: string): AgentVersionInfo | null {
  return agentVersionsOf(envId)?.agents.find((a) => a.harness === harness) ?? null;
}

export function agentUpdateError(envId: string | null | undefined, harness: string): string | null {
  return agentUpdateErrors.value.get(errorKey(envId, harness)) ?? null;
}

/** How many agents of a status have a newer version (`behind`). */
export function countBehind(status: AgentVersionsStatus | null): number {
  return status ? status.agents.filter((a) => a.state === "behind").length : 0;
}

const behindCache = new Map<string, ReadonlySignal<number>>();
/** Number of agents in `behind` state on an environment (Settings → Agents shows a dot). */
export function agentsBehind(envId?: string | null): ReadonlySignal<number> {
  const key = agentVersionsKey(envId);
  let cached = behindCache.get(key);
  if (!cached) behindCache.set(key, (cached = computed(() => countBehind(agentVersions.value.get(key) ?? null))));
  return cached;
}

/** Apply a status (API answer or push) for an environment. */
export function handleAgentVersions(status: AgentVersionsStatus, envId?: string | null): void {
  if (!isStatus(status)) return;
  const key = agentVersionsKey(envId);
  agentVersions.value = new Map(agentVersions.value).set(key, status);
  if (agentVersionsError.value.has(key)) agentVersionsError.value = without(agentVersionsError.value, key);
  schedulePoll(envId);
}

/** The local server's `agent_versions` push. */
export function receiveAgentVersionsMessage(message: ServerMessage): void {
  if (message.type === "batch") {
    for (const m of message.messages) receiveAgentVersionsMessage(m);
    return;
  }
  if (message.type === "agent_versions") handleAgentVersions(message.status, null);
}

function via(envId: string | null | undefined): RequestFn {
  return requestFor(envId) ?? request;
}

/** Load an environment's status (no new check). */
export async function loadAgentVersions(envId?: string | null): Promise<void> {
  try {
    handleAgentVersions(await apiAgentVersions.getAgentVersions(via(envId)), envId);
  } catch (err) {
    setFetchError(envId, err);
  }
}

/**
 * Ask the environment to check now (answers when done). `force: false` (the page opening) reuses
 * a check from the last 10 minutes; Check Now forces it.
 */
export async function checkAgentVersions(envId?: string | null, force = false): Promise<void> {
  const key = agentVersionsKey(envId);
  agentVersionsChecking.value = new Set([...agentVersionsChecking.value, key]);
  try {
    handleAgentVersions(await apiAgentVersions.checkAgentVersions(force, via(envId)), envId);
  } catch (err) {
    setFetchError(envId, err);
  } finally {
    const next = new Set(agentVersionsChecking.value);
    next.delete(key);
    agentVersionsChecking.value = next;
  }
}

/** Update an agent (now, or when its working chats finish). Resolves `true` when accepted. */
export function updateAgent(envId: string | null | undefined, harness: string): Promise<boolean> {
  return jobAction(envId, harness, () => apiAgentVersions.startAgentUpdate(harness, via(envId)));
}

/** Cancel an update that's waiting for chats. Resolves `true` when it worked. */
export function cancelAgentUpdate(envId: string | null | undefined, harness: string): Promise<boolean> {
  return jobAction(envId, harness, () => apiAgentVersions.cancelAgentUpdate(harness, via(envId)));
}

async function jobAction(envId: string | null | undefined, harness: string, call: () => Promise<AgentVersionsStatus>): Promise<boolean> {
  const key = errorKey(envId, harness);
  if (agentUpdateErrors.value.has(key)) agentUpdateErrors.value = without(agentUpdateErrors.value, key);
  try {
    handleAgentVersions(await call(), envId);
    return true;
  } catch (err) {
    agentUpdateErrors.value = new Map(agentUpdateErrors.value).set(key, errorText(err));
    return false;
  }
}

/** Something is in progress (a check, an update running or waiting): the status will change. */
export function isActive(status: AgentVersionsStatus | null): boolean {
  return !!status && (status.checking || status.agents.some((a) => a.update?.state === "running" || a.update?.state === "waiting"));
}

// ── Polling another Mac (no pushes from there) ─────────────────────────────────────────────────

const POLL_MS = 1500;
const polls = new Map<string, ReturnType<typeof setTimeout>>();

function schedulePoll(envId: string | null | undefined): void {
  const key = agentVersionsKey(envId);
  if (key === "" || polls.has(key) || !isActive(agentVersions.value.get(key) ?? null)) return;
  polls.set(
    key,
    setTimeout(() => {
      polls.delete(key);
      void loadAgentVersions(envId);
    }, POLL_MS),
  );
}

// ── Startup ────────────────────────────────────────────────────────────────────────────────────

let started = false;

/**
 * Follow the local server's pushes and load its status now and then, so the Agents dot is right
 * without opening the page. Call once at startup.
 */
export function startAgentVersionsSync(socket: Socket = localSocket): void {
  if (started) return;
  started = true;
  socket.onMessage(receiveAgentVersionsMessage);
  socket.onReconnect(() => void loadAgentVersions(null));
  // The server's first check runs ~30 s after it starts.
  setTimeout(() => void loadAgentVersions(null), 1000);
  setTimeout(() => void loadAgentVersions(null), 45_000);
  setInterval(() => void loadAgentVersions(null), 30 * 60 * 1000);
}

/** Follow the local push while mounted (no-op once {@link startAgentVersionsSync} ran). */
export function watchAgentVersions(socket: Socket = localSocket): () => void {
  if (started) return () => {};
  return socket.onMessage(receiveAgentVersionsMessage);
}

// ── Text ──────────────────────────────────────────────────────────────────────────────────────

export type AgentVersionTone = "on" | "pending" | "off" | "error" | "info";

/** The status line next to "Installed 2.1.280". */
export function versionStatusText(info: AgentVersionInfo | null, checking = false): { text: string; tone: AgentVersionTone } {
  if (!info || info.state === "unknown") return { text: checking ? "Checking…" : (info?.reason ?? "Not checked yet"), tone: "off" };
  switch (info.state) {
    case "behind":
      return { text: `${info.latest} available`, tone: "info" };
    case "up-to-date":
      return { text: "Up to date", tone: "on" };
    case "not-installed":
      return { text: "Not installed", tone: "off" };
    case "failed":
      return { text: `Couldn't check: ${info.reason ?? "unknown error"}`, tone: "error" };
  }
}

const chats = (n: number) => `${n} chat${n === 1 ? "" : "s"}`;

/** "Updates when 2 chats finish" */
export function waitingText(n: number | undefined): string {
  return n && n > 0 ? `Updates when ${chats(n)} finish${n === 1 ? "es" : ""}` : "Updates when chats finish";
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────

function isStatus(value: unknown): value is AgentVersionsStatus {
  return !!value && typeof value === "object" && Array.isArray((value as AgentVersionsStatus).agents);
}

function setFetchError(envId: string | null | undefined, err: unknown): void {
  const text = (err as { status?: number }).status === 404 ? "Glade on this Mac can't check agent versions yet. Update it." : errorText(err);
  agentVersionsError.value = new Map(agentVersionsError.value).set(agentVersionsKey(envId), text);
}

function errorKey(envId: string | null | undefined, harness: string): string {
  return `${agentVersionsKey(envId)}\n${harness}`;
}

function without<V>(map: ReadonlyMap<string, V>, key: string): Map<string, V> {
  const next = new Map(map);
  next.delete(key);
  return next;
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/failed to fetch|networkerror|load failed/i.test(message)) return "Couldn't reach the Mac.";
  return message || "Something went wrong.";
}
