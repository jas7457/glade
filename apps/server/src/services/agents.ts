/**
 * Building blocks of the agent API (I-037): the sub-agent records, the per-process tokens that
 * identify calling sessions, and the texts sub-agents and their parents see. The orchestration
 * (spawn, deliver, close) lives in AppService, which owns the sessions and their processes.
 *
 * Records are kept in the store (`agents` table, keyed by the sub-agent's session id) so a
 * sub-agent reopened after a restart still gets its role prompt and tool allowlist. Tokens are
 * memory only: a new one per agent process, revoked when the process stops.
 */
import { randomBytes } from "node:crypto";
import { agentOpenNote, formatAgentExited, formatAgentFinished, formatAgentMessage } from "@glade/protocol";
import type { AgentInfo, AgentStatus, SessionAgentState, SpawnedAgentRef } from "@glade/protocol";
import type { Store } from "../store/store.js";

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
  /**
   * The harness's own sub-agent (I-188), named by the harness's label ("Claude Code"): mirrored
   * read-only from the parent's process (no process, prompt or token of its own) and left out of
   * the agent API. It's `closed` once it ended; `doneAt`/`result` when it finished.
   */
  native?: string;
  /** The parent's tool call that started it (native sub-agents). */
  toolCallId?: string;
}

/**
 * Sub-agent records, kept in the store's `agents` table (I-121; `agents.json` before). Shared with
 * other servers on the same data folder (I-062): patches apply to the database's current copy of
 * a record, and `onExternalChange` reports records another server changed.
 */
export class AgentRegistry {
  constructor(private readonly store: Store) {}

  /** Session ids whose record another server added, changed or removed. */
  onExternalChange(listener: (sessionIds: string[]) => void): () => void {
    return this.store.onExternalAgentChange(listener);
  }

  private get records(): AgentRecord[] {
    return this.store.listAgents();
  }

  get(sessionId: string): AgentRecord | undefined {
    return this.store.getAgent(sessionId);
  }

  /** Sub-agents of one parent, oldest first. */
  childrenOf(parentSessionId: string): AgentRecord[] {
    return this.records.filter((r) => r.parentSessionId === parentSessionId).sort((a, b) => a.spawnedAt - b.spawnedAt);
  }

  /** Sub-agents of a workspace that haven't been closed (native ones too: names and colours). */
  activeIn(workspaceId: string): AgentRecord[] {
    return this.records.filter((r) => r.workspaceId === workspaceId && !r.closed);
  }

  /** The caller's most recent sub-agent called `name`, active or not (agent API: Glade's own only). */
  findLatest(parentSessionId: string, name: string): AgentRecord | undefined {
    return this.childrenOf(parentSessionId)
      .reverse()
      .find((r) => r.name === name && !r.native);
  }

  /** The caller's active sub-agent (or teammate) called `name` (agent API: Glade's own only). */
  findActive(parentSessionId: string, name: string): AgentRecord | undefined {
    return this.childrenOf(parentSessionId)
      .reverse()
      .find((r) => r.name === name && !r.closed && !r.native);
  }

  upsert(record: AgentRecord): AgentRecord {
    return this.store.upsertAgent(record);
  }

  /** Patch a record (applied to the stored copy, so other fields another server changed survive). */
  update(sessionId: string, patch: Partial<AgentRecord>): AgentRecord | undefined {
    if (!this.get(sessionId)) return undefined;
    return this.store.patchAgent(sessionId, patch);
  }

  remove(sessionId: string): void {
    if (!this.get(sessionId)) return;
    this.store.removeAgents([sessionId]);
  }

  /** Drop every record matching `predicate` (e.g. the sub-agents of a deleted session). */
  removeWhere(predicate: (record: AgentRecord) => boolean): void {
    this.store.removeAgents(this.records.filter(predicate).map((r) => r.sessionId));
  }

  /** Writes are immediate; kept for callers. */
  flush(): void {}
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

/**
 * The sub-agent's role, appended to its system prompt (same content as agent-teams' role.md).
 * `displayName` is the fun name the user sees (I-120); `teammates` are labels like
 * `Leo (t3-research)` (see `agentLabel`).
 */
export function buildRolePrompt(opts: {
  name: string;
  displayName?: string | null;
  teammates: string[];
  agent?: string | null;
  agentPrompt?: string | null;
}): string {
  const shownAs = opts.displayName ? ` (the user sees you as ${opts.displayName})` : "";
  return [
    "# agent-teams: you are a sub-agent",
    "",
    `You are "${opts.name}"${shownAs}, a sub-agent spawned by the main Pi session ("${MAIN_AGENT}") to handle one delegated task.`,
    "You run in your own tab in Glade. The user can watch you and may type to you directly; treat their messages as authoritative.",
    "",
    "- Your task is the first user message. Stay within its scope.",
    `- If you are blocked or need a decision, call message_agent with to:"${MAIN_AGENT}".`,
    "- When finished, call report_done with a concise, self-contained summary: what you did, files changed, findings, open issues. The main session only sees what you put in report_done.",
    `- Other active sub-agents: ${opts.teammates.join(", ") || "(none yet)"}. You can reach them with message_agent (by the code name in parentheses).`,
    opts.agentPrompt?.trim() ? `\n## Agent role: ${opts.agent ?? opts.name}\n\n${opts.agentPrompt.trim()}` : "",
  ].join("\n");
}

/**
 * Prompt text delivered to a session: a message from another agent (format shared via protocol,
 * I-075). A sub-agent sender is named `Leo (t3-research)` (I-120); `main` stays `main`.
 */
export function messageText(from: string | Pick<AgentRecord, "name" | "displayName">, text: string): string {
  return typeof from === "string" ? formatAgentMessage(from, text) : formatAgentMessage(from.name, text, from.displayName);
}

/** Prompt text delivered to the parent when a sub-agent reports: `[agent-teams] Leo (t3-research) finished:`. */
export function doneText(record: AgentRecord, summary: string): string {
  return formatAgentFinished(record.name, summary, openNote(record), record.displayName);
}

/**
 * Prompt text delivered to the parent when a sub-agent stopped without reporting. Pass the
 * record to name it by its display name too (I-120); a bare name still works.
 */
export function exitedText(agent: string | Pick<AgentRecord, "name" | "displayName">, reason: string): string {
  return typeof agent === "string" ? formatAgentExited(agent, reason) : formatAgentExited(agent.name, reason, agent.displayName);
}

/** After a result, tell the parent what happens to the sub-agent so it acts on it. */
function openNote(record: AgentRecord): string {
  return agentOpenNote({
    name: record.name,
    displayName: record.displayName,
    closing: record.closing || record.closed,
    userEngaged: record.userEngaged,
    keepOpenReason: record.keepOpenReason,
    idleMinutes: Math.round(IDLE_CLOSE_MS / 60_000),
  });
}

function agentStatus(record: AgentRecord, running: boolean | null): AgentStatus {
  // A native sub-agent that finished is done (it ended for good, but not by crashing).
  if (record.native && record.closed && record.doneAt !== null && !record.removed) return "done";
  return record.closed || record.removed ? "closed" : record.doneAt !== null && !running ? "done" : running ? "working" : "idle";
}

export function agentInfo(record: AgentRecord, running: boolean | null): AgentInfo {
  return {
    name: record.name,
    ...(record.displayName ? { displayName: record.displayName } : {}),
    ...(record.color ? { color: record.color } : {}),
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
    ...(record.native ? { native: record.native } : {}),
  };
}

/** A record as its parent's `SessionSummary.spawnedAgents` entry (I-084). */
export function spawnedAgentRef(record: AgentRecord): SpawnedAgentRef {
  const ref: SpawnedAgentRef = { name: record.name, sessionId: record.sessionId, spawnedAt: record.spawnedAt };
  if (record.displayName) ref.displayName = record.displayName;
  if (record.color) ref.color = record.color;
  if (record.toolCallId) ref.toolCallId = record.toolCallId;
  if (record.native) ref.native = true;
  return ref;
}
