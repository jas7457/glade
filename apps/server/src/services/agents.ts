/**
 * Building blocks of the agent API (I-037): the sub-agent records, the per-process tokens that
 * identify calling sessions, and the texts sub-agents and their parents see. The orchestration
 * (spawn, deliver, close) lives in AppService, which owns the sessions and their processes.
 *
 * Records are kept in `<dataDir>/agents.json` (keyed by the sub-agent's session id) so a
 * sub-agent reopened after a restart still gets its role prompt and tool allowlist. Tokens are
 * memory only: a new one per agent process, revoked when the process stops.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { agentOpenNote, formatAgentExited, formatAgentFinished, formatAgentMessage } from "@glade/protocol";
import type { AgentInfo, AgentStatus, SessionAgentState, SpawnedAgentRef } from "@glade/protocol";
import { JsonFile } from "../store/json-file.js";

/** The name a sub-agent uses for its parent. */
export const MAIN_AGENT = "main";

/** A finished sub-agent kept open that nobody used for this long gets closed. */
export const IDLE_CLOSE_MS = 10 * 60_000;

/** After close_agent on a running sub-agent, stop it anyway after this long. */
export const CLOSE_GRACE_MS = 30_000;

export interface AgentRecord {
  /** The sub-agent's session id. */
  sessionId: string;
  parentSessionId: string;
  workspaceId: string;
  name: string;
  /** Fun display name and colour key (I-084); absent on records from before. */
  displayName?: string;
  color?: string;
  agent: string | null;
  task: string;
  /** Appended to its system prompt (built once at spawn). */
  systemPrompt: string;
  tools: string[] | null;
  /** Stop it after report_done (unless the user typed in it or it asked to stay open). */
  autoClose: boolean;
  keepOpenReason: string | null;
  userEngaged: boolean;
  spawnedAt: number;
  doneAt: number | null;
  result: string | null;
  /** Stops when its current turn ends. */
  closing: boolean;
  /** Finished for good (closed, or its process crashed); it no longer counts as active. */
  closed: boolean;
  /**
   * Its session (tab + conversation) was deleted when it closed (I-055). The record stays so
   * list_agents shows it and close_agent is idempotent; it goes with its parent session.
   */
  removed?: boolean;
}

interface AgentsFile {
  version: 1;
  agents: AgentRecord[];
}

/**
 * Sub-agent records; persisted when given a data dir, memory only otherwise (tests). The file is
 * shared with other servers on the same data folder (I-062): every change is an operation on the
 * file's current content (JsonFile), and `onExternalChange` reports records another server changed.
 */
export class AgentRegistry {
  /** Exposed so the store's folder watcher can reload it. */
  readonly file: JsonFile<AgentsFile> | null;
  private memory: AgentRecord[] = [];

  constructor(dataDir?: string) {
    this.file = dataDir ? new JsonFile<AgentsFile>(join(dataDir, "agents.json"), () => ({ version: 1, agents: [] })) : null;
  }

  private get records(): AgentRecord[] {
    return this.file ? this.file.get().agents : this.memory;
  }

  private apply(fn: (records: AgentRecord[]) => AgentRecord[]): void {
    if (this.file) this.file.update((f) => ({ ...f, version: 1, agents: fn(f.agents) }));
    else this.memory = fn(this.memory);
  }

  /** Session ids whose record another server added, changed or removed. */
  onExternalChange(listener: (sessionIds: string[]) => void): () => void {
    if (!this.file) return () => {};
    return this.file.onExternalChange((before, after) => {
      const old = new Map(before.agents.map((r) => [r.sessionId, JSON.stringify(r)]));
      const changed = after.agents.filter((r) => old.get(r.sessionId) !== JSON.stringify(r)).map((r) => r.sessionId);
      const kept = new Set(after.agents.map((r) => r.sessionId));
      listener([...changed, ...[...old.keys()].filter((id) => !kept.has(id))]);
    });
  }

  get(sessionId: string): AgentRecord | undefined {
    return this.records.find((r) => r.sessionId === sessionId);
  }

  /** Sub-agents of one parent, oldest first. */
  childrenOf(parentSessionId: string): AgentRecord[] {
    return this.records.filter((r) => r.parentSessionId === parentSessionId).sort((a, b) => a.spawnedAt - b.spawnedAt);
  }

  /** Sub-agents of a workspace that haven't been closed. */
  activeIn(workspaceId: string): AgentRecord[] {
    return this.records.filter((r) => r.workspaceId === workspaceId && !r.closed);
  }

  /** The caller's most recent sub-agent called `name`, active or not. */
  findLatest(parentSessionId: string, name: string): AgentRecord | undefined {
    return this.childrenOf(parentSessionId)
      .reverse()
      .find((r) => r.name === name);
  }

  /** The caller's active sub-agent (or teammate) called `name`. */
  findActive(parentSessionId: string, name: string): AgentRecord | undefined {
    return this.childrenOf(parentSessionId)
      .reverse()
      .find((r) => r.name === name && !r.closed);
  }

  upsert(record: AgentRecord): AgentRecord {
    this.apply((records) => [...records.filter((r) => r.sessionId !== record.sessionId), record]);
    return record;
  }

  /** Patch a record (applied to the file's current copy of it, so other fields another server changed survive). */
  update(sessionId: string, patch: Partial<AgentRecord>): AgentRecord | undefined {
    if (!this.get(sessionId)) return undefined;
    this.apply((records) => records.map((r) => (r.sessionId === sessionId ? { ...r, ...patch } : r)));
    return this.get(sessionId);
  }

  remove(sessionId: string): void {
    if (!this.get(sessionId)) return;
    this.apply((records) => records.filter((r) => r.sessionId !== sessionId));
  }

  /** Drop every record matching `predicate` (e.g. the sub-agents of a deleted session). */
  removeWhere(predicate: (record: AgentRecord) => boolean): void {
    if (!this.records.some(predicate)) return;
    this.apply((records) => records.filter((r) => !predicate(r)));
  }

  flush(): void {
    this.file?.flush();
  }
}

/** Per-process secrets for the agent API: token -> session id. */
export class AgentTokens {
  private readonly bySession = new Map<string, string>();
  private readonly byToken = new Map<string, string>();

  /** A fresh token for a session's new process (the previous one stops working). */
  issue(sessionId: string): string {
    this.revoke(sessionId);
    const token = randomBytes(24).toString("base64url");
    this.bySession.set(sessionId, token);
    this.byToken.set(token, sessionId);
    return token;
  }

  revoke(sessionId: string): void {
    const token = this.bySession.get(sessionId);
    if (token) this.byToken.delete(token);
    this.bySession.delete(sessionId);
  }

  sessionFor(token: string): string | undefined {
    return this.byToken.get(token);
  }
}

/** `Auth-Scout 1` → `auth-scout-1`; empty when nothing usable is left. */
export function normalizeAgentName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/** The sub-agent's role, appended to its system prompt (same content as agent-teams' role.md). */
export function buildRolePrompt(opts: { name: string; teammates: string[]; agent?: string | null; agentPrompt?: string | null }): string {
  return [
    "# agent-teams: you are a sub-agent",
    "",
    `You are "${opts.name}", a sub-agent spawned by the main Pi session ("${MAIN_AGENT}") to handle one delegated task.`,
    "You run in your own tab in Glade. The user can watch you and may type to you directly; treat their messages as authoritative.",
    "",
    "- Your task is the first user message. Stay within its scope.",
    `- If you are blocked or need a decision, call message_agent with to:"${MAIN_AGENT}".`,
    "- When finished, call report_done with a concise, self-contained summary: what you did, files changed, findings, open issues. The main session only sees what you put in report_done.",
    `- Other active sub-agents: ${opts.teammates.join(", ") || "(none yet)"}. You can reach them with message_agent.`,
    opts.agentPrompt?.trim() ? `\n## Agent role: ${opts.agent ?? opts.name}\n\n${opts.agentPrompt.trim()}` : "",
  ].join("\n");
}

/** Prompt text delivered to a session: a message from another agent (format shared via protocol, I-075). */
export function messageText(from: string, text: string): string {
  return formatAgentMessage(from, text);
}

/** Prompt text delivered to the parent when a sub-agent reports. */
export function doneText(record: AgentRecord, summary: string): string {
  return formatAgentFinished(record.name, summary, openNote(record));
}

/** Prompt text delivered to the parent when a sub-agent stopped without reporting. */
export function exitedText(name: string, reason: string): string {
  return formatAgentExited(name, reason);
}

/** After a result, tell the parent what happens to the sub-agent so it acts on it. */
function openNote(record: AgentRecord): string {
  return agentOpenNote({
    name: record.name,
    closing: record.closing || record.closed,
    userEngaged: record.userEngaged,
    keepOpenReason: record.keepOpenReason,
    idleMinutes: Math.round(IDLE_CLOSE_MS / 60_000),
  });
}

function agentStatus(record: AgentRecord, running: boolean | null): AgentStatus {
  return record.closed || record.removed ? "closed" : record.doneAt !== null && !running ? "done" : running ? "working" : "idle";
}

export function agentInfo(record: AgentRecord, running: boolean | null): AgentInfo {
  return {
    name: record.name,
    sessionId: record.sessionId,
    agent: record.agent,
    task: record.task,
    status: agentStatus(record, running),
    keepOpenReason: record.keepOpenReason,
    userEngaged: record.userEngaged,
    spawnedAt: record.spawnedAt,
    doneAt: record.doneAt,
    result: record.result,
    tabOpen: !record.removed,
  };
}

/** What the browser sees of a sub-agent (`SessionSummary.agent`, I-054). */
export function sessionAgentState(record: AgentRecord, running: boolean): SessionAgentState {
  return {
    status: agentStatus(record, running),
    agent: record.agent,
    task: record.task,
    keepOpenReason: record.keepOpenReason,
    userEngaged: record.userEngaged,
    closing: record.closing,
    doneAt: record.doneAt,
    result: record.result,
  };
}

/** A record as its parent's `SessionSummary.spawnedAgents` entry (I-084). */
export function spawnedAgentRef(record: AgentRecord): SpawnedAgentRef {
  const ref: SpawnedAgentRef = { name: record.name, sessionId: record.sessionId, spawnedAt: record.spawnedAt };
  if (record.displayName) ref.displayName = record.displayName;
  if (record.color) ref.color = record.color;
  return ref;
}
