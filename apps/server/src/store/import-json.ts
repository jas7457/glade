/**
 * Reads the JSON files older Glade versions kept in the data folder, for the one-time import into
 * `glade.db` (I-121). Only reads: the files are left untouched (they're deleted later, after the
 * new version has started successfully a few times; see `store/startup.ts`). The upgrades those
 * versions applied on load (I-019 sort orders, I-035 chats → workspaces, settings renames) are
 * applied here to what's read.
 *
 * An unreadable file is reported in `failed` (and kept on disk for good) rather than failing the
 * whole start.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeepPartial, Project, Session, Settings, Transcript, Workspace } from "@glade/protocol";
import type { AgentRecord } from "../services/agents.js";
import { migrateChats, type LegacyChat } from "./migrate-workspaces.js";

/** Files the JSON store used (deleted by the cleanup once the migration is confirmed). */
export const LEGACY_JSON_FILES = [
  "projects.json",
  "workspaces.json",
  "chats.json",
  "settings.json",
  "agents.json",
  "session-summaries.json",
  "search-index.json",
] as const;

/** Folders the JSON store used: ACP transcripts (I-119). */
export const LEGACY_JSON_DIRS = ["acp-sessions"] as const;

export interface LegacySummary {
  text: string;
  messageCount: number;
  at: number;
}

/** An ACP chat's JSON file (`acp-sessions/<ref>.json`, I-119). */
export interface LegacyAcpSession {
  ref: string;
  acpSessionId: string | null;
  title: string | null;
  transcript: Transcript;
}

export interface LegacyData {
  projects: Project[];
  workspaces: Workspace[];
  sessions: Session[];
  settings: DeepPartial<Settings> | null;
  agents: AgentRecord[];
  summaries: { enabledAt: number | null; entries: Record<string, LegacySummary> };
  acp: LegacyAcpSession[];
  /** Files/folders that were there and were read. */
  files: string[];
  /** Files that were there but couldn't be read (never deleted automatically). */
  failed: Array<{ file: string; error: string }>;
}

export function readLegacyData(dataDir: string): LegacyData {
  const data: LegacyData = {
    projects: [],
    workspaces: [],
    sessions: [],
    settings: null,
    agents: [],
    summaries: { enabledAt: null, entries: {} },
    acp: [],
    files: [],
    failed: [],
  };
  const read = <T>(file: string): T | null => {
    const path = join(dataDir, file);
    if (!existsSync(path)) return null;
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as T;
      data.files.push(file);
      return value;
    } catch (err) {
      data.failed.push({ file, error: (err as Error).message });
      return null;
    }
  };

  const projects = read<{ projects?: Project[] }>("projects.json");
  data.projects = migrateProjects(projects?.projects ?? []);

  const workspaces = read<{ workspaces?: Workspace[]; sessions?: Session[] }>("workspaces.json");
  if (workspaces) {
    data.workspaces = workspaces.workspaces ?? [];
    data.sessions = workspaces.sessions ?? [];
    // The pre-I-035 index, kept by older versions as a backup (no longer read): goes with the rest.
    const chats = join(dataDir, "chats.json");
    if (existsSync(chats)) {
      try {
        JSON.parse(readFileSync(chats, "utf8"));
        data.files.push("chats.json");
      } catch {
        /* unreadable: left alone for good */
      }
    }
  } else if (!existsSync(join(dataDir, "workspaces.json"))) {
    // I-035: only a pre-workspaces chat index.
    const chats = read<{ chats?: LegacyChat[] }>("chats.json");
    if (chats) ({ workspaces: data.workspaces, sessions: data.sessions } = migrateChats(chats.chats ?? []));
  }
  data.workspaces = migratePinOrder(data.workspaces);

  const settings = read<DeepPartial<Settings>>("settings.json");
  data.settings = settings ? migrateSettings(settings) : null;

  data.agents = read<{ agents?: AgentRecord[] }>("agents.json")?.agents ?? [];

  const summaries = read<{ enabledAt?: number; summaries?: Record<string, LegacySummary> }>("session-summaries.json");
  if (summaries) data.summaries = { enabledAt: typeof summaries.enabledAt === "number" ? summaries.enabledAt : null, entries: summaries.summaries ?? {} };

  // search-index.json is only a cache of text now kept in the messages table: not imported.
  if (existsSync(join(dataDir, "search-index.json"))) data.files.push("search-index.json");

  const acpDir = join(dataDir, "acp-sessions");
  if (existsSync(acpDir)) {
    data.files.push("acp-sessions");
    let names: string[] = [];
    try {
      names = readdirSync(acpDir).filter((n) => n.endsWith(".json"));
    } catch (err) {
      data.failed.push({ file: "acp-sessions", error: (err as Error).message });
    }
    for (const name of names) {
      try {
        const file = JSON.parse(readFileSync(join(acpDir, name), "utf8")) as Partial<LegacyAcpSession> & { version?: number };
        if (file.version !== 1 || !file.transcript) continue;
        data.acp.push({
          ref: name.slice(0, -".json".length),
          acpSessionId: typeof file.acpSessionId === "string" ? file.acpSessionId : null,
          title: typeof file.title === "string" ? file.title : null,
          transcript: file.transcript,
        });
      } catch (err) {
        data.failed.push({ file: `acp-sessions/${name}`, error: (err as Error).message });
      }
    }
  }
  return data;
}

// Upgrades older versions applied when loading their JSON (moved here from the JSON store) -------

/** Stored-settings upgrades. Returns the same object when nothing changes. */
export function migrateSettings(stored: DeepPartial<Settings>): DeepPartial<Settings> {
  return migrateSmallModel(migratePiSettings(dropRemovedGeneral(stored)));
}

/**
 * I-074: `models.titleModel` became `models.smallModel` (one small model for titles, `/name`,
 * summaries and search). A value already under `smallModel` wins.
 */
function migrateSmallModel(stored: DeepPartial<Settings>): DeepPartial<Settings> {
  const models = (stored as { models?: Record<string, unknown> }).models;
  if (!models || !("titleModel" in models)) return stored;
  const { titleModel, ...rest } = models;
  const next = "smallModel" in rest ? rest : { ...rest, smallModel: titleModel };
  return { ...stored, models: next } as DeepPartial<Settings>;
}

/**
 * `general` settings that no longer exist: `notifyOnComplete` (I-028, system notifications were
 * removed), `sendKey` and `busyBehavior` (I-153, the send keys are fixed).
 */
const REMOVED_GENERAL_KEYS = ["notifyOnComplete", "sendKey", "busyBehavior"] as const;

/**
 * Drop removed `general` settings from stored settings. Applied when reading (old values are
 * tolerated, just ignored) and to the stored overrides before each write (so they go away).
 */
export function dropRemovedGeneral(stored: DeepPartial<Settings>): DeepPartial<Settings> {
  const general = (stored as { general?: Record<string, unknown> }).general;
  if (!general || !REMOVED_GENERAL_KEYS.some((k) => k in general)) return stored;
  const rest: Record<string, unknown> = { ...general };
  for (const key of REMOVED_GENERAL_KEYS) delete rest[key];
  return { ...stored, general: rest } as DeepPartial<Settings>;
}

/** pi's settings kept in `agent` before I-066. */
const LEGACY_PI_KEYS = ["piPath", "extraArgs", "autoCompaction", "autoRetry"] as const;

/**
 * I-066: pi's settings moved from `agent` to `harnesses.pi`. Values already under
 * `harnesses.pi` win (e.g. written by a newer server while an older one still wrote `agent`).
 */
function migratePiSettings(stored: DeepPartial<Settings>): DeepPartial<Settings> {
  const agent = (stored as { agent?: Record<string, unknown> }).agent;
  if (!agent || !LEGACY_PI_KEYS.some((k) => k in agent)) return stored;
  const rest: Record<string, unknown> = { ...agent };
  const moved: Record<string, unknown> = {};
  for (const key of LEGACY_PI_KEYS) {
    if (key in rest) moved[key] = rest[key];
    delete rest[key];
  }
  const harnesses = (stored as { harnesses?: Record<string, Record<string, unknown>> }).harnesses ?? {};
  const pi = { ...moved, ...harnesses.pi };
  return { ...stored, agent: rest, harnesses: { ...harnesses, pi } } as DeepPartial<Settings>;
}

/**
 * I-019: projects get a manual `sortOrder` (from their previous order: pinned first, then most
 * recently active) and lose `pinned`.
 */
export function migrateProjects(list: Project[]): Project[] {
  /** Shape of projects written before I-019 (may have `pinned`, may lack `sortOrder`). */
  type LegacyProject = Project & { pinned?: boolean };
  const projects = list as LegacyProject[];
  if (!projects.some((p) => typeof p.sortOrder !== "number" || "pinned" in p)) return list;
  const byPrevious = (a: LegacyProject, b: LegacyProject) =>
    Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.lastActivityAt - a.lastActivityAt;
  const ordered = projects.filter((p) => typeof p.sortOrder === "number");
  let next = ordered.length ? Math.max(...ordered.map((p) => p.sortOrder)) + 1 : 0;
  const missing = new Map(
    projects
      .filter((p) => typeof p.sortOrder !== "number")
      .sort(byPrevious)
      .map((p) => [p.id, next++] as const),
  );
  return projects.map(({ pinned: _pinned, ...p }) => ({ ...p, sortOrder: missing.get(p.id) ?? p.sortOrder }));
}

/** I-019: pinned chats get a `pinOrder` per list (most recent activity first); unpinned lose it. */
export function migratePinOrder(workspaces: Workspace[]): Workspace[] {
  const needsPinOrder = (w: Workspace) => w.pinned && typeof w.pinOrder !== "number";
  const strayPinOrder = (w: Workspace) => !w.pinned && w.pinOrder !== undefined;
  if (!workspaces.some((w) => needsPinOrder(w) || strayPinOrder(w))) return workspaces;
  const assigned = new Map<string, number>();
  for (const listId of new Set(workspaces.map((w) => w.projectId))) {
    const pinned = workspaces.filter((w) => w.projectId === listId && w.pinned);
    const ordered = pinned.filter((w) => typeof w.pinOrder === "number");
    let next = ordered.length ? Math.max(...ordered.map((w) => w.pinOrder!)) + 1 : 0;
    for (const w of pinned.filter(needsPinOrder).sort((a, b) => b.lastActivityAt - a.lastActivityAt)) {
      assigned.set(w.id, next++);
    }
  }
  return workspaces.map((w) => {
    if (strayPinOrder(w)) {
      const { pinOrder: _pinOrder, ...rest } = w;
      return rest;
    }
    return assigned.has(w.id) ? { ...w, pinOrder: assigned.get(w.id)! } : w;
  });
}
