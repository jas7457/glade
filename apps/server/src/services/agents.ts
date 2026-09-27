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
import type { AgentInfo, AgentStatus, SessionAgentState } from "@pi-ui/protocol";
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

/** Sub-agent records; persisted when given a data dir, memory only otherwise (tests). */
export class AgentRegistry {
  private readonly file: JsonFile<AgentsFile> | null;
  private records: AgentRecord[];

  constructor(dataDir?: string) {
    this.file = dataDir ? new JsonFile(join(dataDir, "agents.json"), () => ({ version: 1, agents: [] })) : null;
    this.records = this.file?.get().agents ?? [];
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
    this.records = [...this.records.filter((r) => r.sessionId !== record.sessionId), record];
    this.save();
    return record;
  }

  update(sessionId: string, patch: Partial<AgentRecord>): AgentRecord | undefined {
    const current = this.get(sessionId);
    return current ? this.upsert({ ...current, ...patch }) : undefined;
  }

  remove(sessionId: string): void {
    if (!this.get(sessionId)) return;
    this.records = this.records.filter((r) => r.sessionId !== sessionId);
    this.save();
  }

  /** Drop every record matching `predicate` (e.g. the sub-agents of a deleted session). */
  removeWhere(predicate: (record: AgentRecord) => boolean): void {
    const kept = this.records.filter((r) => !predicate(r));
    if (kept.length === this.records.length) return;
    this.records = kept;
    this.save();
  }

  flush(): void {
    this.file?.flush();
  }

  private save(): void {
    this.file?.set({ version: 1, agents: this.records });
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
    "You run in your own tab in pi-ui. The user can watch you and may type to you directly; treat their messages as authoritative.",
    "",
    "- Your task is the first user message. Stay within its scope.",
    `- If you are blocked or need a decision, call message_agent with to:"${MAIN_AGENT}".`,
    "- When finished, call report_done with a concise, self-contained summary: what you did, files changed, findings, open issues. The main session only sees what you put in report_done.",
    `- Other active sub-agents: ${opts.teammates.join(", ") || "(none yet)"}. You can reach them with message_agent.`,
    opts.agentPrompt?.trim() ? `\n## Agent role: ${opts.agent ?? opts.name}\n\n${opts.agentPrompt.trim()}` : "",
  ].join("\n");
}

/** Prompt text delivered to a session: a message from another agent. */
export function messageText(from: string, text: string): string {
  return `[agent-teams] message from ${from}:\n${text}`;
}

/** Prompt text delivered to the parent when a sub-agent reports. */
export function doneText(record: AgentRecord, summary: string): string {
  return `[agent-teams] ${record.name} finished:\n${summary}${openNote(record)}`;
}

/** Prompt text delivered to the parent when a sub-agent stopped without reporting. */
export function exitedText(name: string, reason: string): string {
  return `[agent-teams] ${name} exited:\n${reason}`;
}

/** After a result, tell the parent what happens to the sub-agent so it acts on it. */
function openNote(record: AgentRecord): string {
  if (record.closing || record.closed) return "";
  if (record.userEngaged) return `\n\n(${record.name}'s tab stays open because the user has typed in it. Leave it to the user.)`;
  const idle = `${Math.round(IDLE_CLOSE_MS / 60_000)} idle minutes`;
  return (
    `\n\n(${record.name} is still open${record.keepOpenReason ? ` — kept open for: ${record.keepOpenReason}` : ""}. ` +
    `If that follow-up is still planned, send it now with message_agent. Otherwise call close_agent. ` +
    `It closes automatically after ${idle}.)`
  );
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
