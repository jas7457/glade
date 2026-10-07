/**
 * "Is this Glade behind?" (I-149): the local server's build stamp and its last behind check
 * (`GET /api/version`, checked by the server at startup and every few hours), shown in
 * the top of Settings → General (I-160) and as a quiet dot on the sidebar's Settings row. Also compares other
 * devices' builds with ours for Connections.
 *
 * I-197: the server also pushes its status as `version` (a check finished, or a newer build was
 * installed into the Mac app's bundle: `installed`), followed by {@link startVersionSync}.
 *
 * Portable client core (F-022): the text helpers are pure.
 */
import { computed, signal } from "@preact/signals";
import type { BuildComparison, BuildInfo, ServerMessage, VersionStatus } from "@glade/protocol";
import { request } from "@glade/app-core/lib/api";
import { socket as localSocket, type Socket } from "@glade/app-core/lib/socket";

/** The local server's status; null until loaded (or on servers from before I-149). */
export const versionStatus = signal<VersionStatus | null>(null);
/** The last load/check failed (e.g. an older server without the API). */
export const versionError = signal<string | null>(null);
/** Check Now is running. */
export const versionChecking = signal(false);

/** This device's build (the local server's), when known. */
export const ownBuild = computed<BuildInfo | null>(() => versionStatus.value?.build ?? null);

/** There's a newer Glade on origin's main: the sidebar's Settings row gets a dot. */
export const updateAvailable = computed(() => {
  const state = versionStatus.value?.check?.state;
  return state === "behind" || state === "update-available";
});

function isVersionStatus(value: unknown): value is VersionStatus {
  return !!value && typeof value === "object" && "build" in value && "check" in value;
}

export async function loadVersion(): Promise<void> {
  try {
    const status = await request<VersionStatus>("GET", "/version");
    if (!isVersionStatus(status)) throw new Error("This server doesn't report its version.");
    versionStatus.value = status;
    versionError.value = null;
  } catch (err) {
    versionError.value = (err as Error).message;
  }
}

/** Check Now: asks the server to check origin (answers when done). */
export async function checkVersionNow(): Promise<void> {
  versionChecking.value = true;
  try {
    const status = await request<VersionStatus>("POST", "/version/check");
    if (!isVersionStatus(status)) throw new Error("This server doesn't report its version.");
    versionStatus.value = status;
    versionError.value = null;
  } catch (err) {
    versionError.value = (err as Error).message;
  } finally {
    versionChecking.value = false;
  }
}

/** Applies the local server's `version` push (I-197). */
export function receiveVersionMessage(message: ServerMessage): void {
  if (message.type === "batch") {
    for (const m of message.messages) receiveVersionMessage(m);
    return;
  }
  if (message.type === "version" && isVersionStatus(message.version)) {
    versionStatus.value = message.version;
    versionError.value = null;
  }
}

/** The server checks every 4 h; the page picks up its result now and then (and every push). */
const REFRESH_MS = 30 * 60 * 1000;
let started = false;

export function startVersionSync(socket: Socket = localSocket): void {
  if (started) return;
  started = true;
  socket.onMessage(receiveVersionMessage);
  // Catch up on what was pushed while disconnected (e.g. an install during a reconnect).
  socket.onReconnect(() => void loadVersion());
  // Give the server's startup check a moment (it runs `git ls-remote`).
  setTimeout(() => void loadVersion(), 1000);
  setTimeout(() => void loadVersion(), 30_000);
  setInterval(() => void loadVersion(), REFRESH_MS);
}

// --- Text ------------------------------------------------------------------------------------

/** "Sep 27, 2026" (local time). */
export function formatBuildDate(iso: string, locale?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

/** "Built from 1f00e8a on Sep 27, 2026" (a dev server: "Running from 1f00e8a (committed …)"). */
export function buildLine(build: BuildInfo, locale?: string): string {
  const date = formatBuildDate(build.builtAt, locale);
  return build.kind === "dev" ? `Running from source at ${build.shortCommit} (committed ${date})` : `Built from ${build.shortCommit} on ${date}`;
}

export type VersionTone = "on" | "pending" | "off" | "error";

/** The status line at the top of Settings → General. */
export function checkText(status: VersionStatus | null): { text: string; tone: VersionTone; detail?: string } {
  const check = status?.check;
  if (!status?.build) return { text: "Unknown build", tone: "off", detail: "This app doesn't know which commit it was built from." };
  if (!check) return { text: status.checking ? "Checking…" : "Not checked yet", tone: "off" };
  switch (check.state) {
    case "up-to-date":
      return { text: "Up to date", tone: "on" };
    case "behind":
      return { text: `${check.behind} commit${check.behind === 1 ? "" : "s"} behind main`, tone: "pending" };
    case "update-available":
      return { text: "Update available", tone: "pending", detail: "main has commits this Mac's copy of the repo hasn't fetched yet." };
    case "failed":
      return { text: "Couldn't check", tone: "error", detail: check.reason };
    case "unavailable":
      return { text: "Can't check", tone: "off", detail: check.reason };
  }
}

// --- Other devices -----------------------------------------------------------------------------

/** How another device's build relates to ours, for Connections; null when the same or unknown. */
export interface BuildRelation {
  relation: "older" | "newer";
  /** Commits, when our repo could count them. */
  count?: number;
}

/**
 * Another device's build vs. ours: the commit count when our repo could compare them
 * (`comparison`), else by build time. Null when either is unknown or they're the same build.
 */
export function buildRelation(ours: BuildInfo | null | undefined, theirs: BuildInfo | null | undefined, comparison?: BuildComparison | null): BuildRelation | null {
  if (!ours || !theirs || ours.commit === theirs.commit) return null;
  if (comparison && comparison.commit === theirs.commit) {
    if (comparison.relation === "same") return null;
    if ((comparison.relation === "older" || comparison.relation === "newer") && comparison.count) return { relation: comparison.relation, count: comparison.count };
  }
  const a = Date.parse(ours.builtAt);
  const b = Date.parse(theirs.builtAt);
  if (Number.isNaN(a) || Number.isNaN(b) || a === b) return null;
  return { relation: b < a ? "older" : "newer" };
}

/** "Running an older Glade (3 commits behind this device)" / "Running a newer Glade". */
export function buildRelationText(rel: BuildRelation): string {
  const n = rel.count;
  const count = n ? ` (${n} commit${n === 1 ? "" : "s"} ${rel.relation === "older" ? "behind" : "ahead of"} this device)` : "";
  return `Running ${rel.relation === "older" ? "an older" : "a newer"} Glade${count}`;
}

export const BUILD_MISMATCH_HINT = "Some features (e.g. quick pairing) need both devices updated.";

/** Comparisons by commit, asked of the local server once each (`GET /api/version/compare`). */
export const buildComparisons = signal<ReadonlyMap<string, BuildComparison>>(new Map());
const asked = new Set<string>();

export function compareBuild(commit: string): void {
  if (asked.has(commit)) return;
  asked.add(commit);
  request<BuildComparison>("GET", `/version/compare?commit=${encodeURIComponent(commit)}`)
    .then((result) => {
      if (result && typeof result.relation === "string") buildComparisons.value = new Map(buildComparisons.value).set(commit, result);
    })
    .catch(() => {
      // older server or no repo: build times only
    });
}
