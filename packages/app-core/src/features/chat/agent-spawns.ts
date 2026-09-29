/**
 * Links a main chat's `task` tool calls to the sub-agents they spawned (I-084), so the call can
 * render as the agent's card (`AgentSpawnCard.tsx`). Pure, so the rules are unit-tested.
 *
 * - Matching: the n-th-from-last spawn call with `input.agentName` X (errored calls skipped) ↔
 *   the n-th-from-last `SessionSummary.spawnedAgents` entry named X (aligned from the end, so
 *   history cut by compaction or older records still line up with the latest agents).
 * - The agent's later messages in this transcript ("finished", "message from", "exited", as
 *   parsed by `parseAgentMessage`) belong to the latest matched spawn of that name before them:
 *   they're shown in the card and hidden from the transcript. Messages without a matching card
 *   (compacted history, no record) stay as `AgentMessageCard`s.
 */
import {
  parseAgentMessage,
  type AgentMessage,
  type SessionSummary,
  type SpawnedAgentRef,
  type ToolCallBlock,
  type Transcript,
  type UserMessage,
} from "@glade/protocol";
import { CHIP_LABELS, chipKind, latestActivity, sessionCwd, type ChipKind } from "@glade/app-core/features/workspace/agent-chips";
import { agentPreview } from "./AgentMessageCard";
import { agentIdentity, sessionAgentIdentity, type AgentIdentityView } from "./agent-identity";

export interface LinkedAgentMessage extends AgentMessage {
  /** The transcript message it came from. */
  id: string;
  timestamp: number;
}

export interface SpawnLink {
  ref: SpawnedAgentRef;
  /** The agent's messages to this chat after the spawn, oldest first. */
  messages: LinkedAgentMessage[];
}

export interface AgentSpawnLinks {
  /** Keyed by tool call id. */
  byCall: Map<string, SpawnLink>;
  /** User messages folded into a card (not rendered on their own). */
  hidden: Set<string>;
}

export const NO_SPAWN_LINKS: AgentSpawnLinks = { byCall: new Map(), hidden: new Set() };

/** The text of a user message (text blocks joined), or null when it has images. */
export function userMessageText(message: UserMessage): string | null {
  if (message.content.some((b) => b.type === "image")) return null;
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n\n");
}

/** A tool call that spawned a sub-agent (`task` with the agent's name). */
export function spawnedAgentName(call: Pick<ToolCallBlock, "kind" | "input">): string | null {
  return call.kind === "task" ? call.input?.agentName?.trim() || null : null;
}

export function linkAgentSpawns(transcript: Transcript, refs: readonly SpawnedAgentRef[] | undefined): AgentSpawnLinks {
  if (!refs?.length) return NO_SPAWN_LINKS;
  // Spawn calls in transcript order, with the index of the message they're in.
  const calls: Array<{ id: string; name: string; at: number }> = [];
  transcript.messages.forEach((m, at) => {
    if (m.role !== "assistant") return;
    for (const b of m.content) {
      if (b.type !== "toolCall") continue;
      const name = spawnedAgentName(b);
      if (name && transcript.toolResults[b.id]?.status !== "error") calls.push({ id: b.id, name, at });
    }
  });
  const byCall = new Map<string, SpawnLink>();
  const matched: Array<{ name: string; at: number; link: SpawnLink }> = [];
  for (const name of new Set(calls.map((c) => c.name))) {
    const named = calls.filter((c) => c.name === name);
    const agents = refs.filter((r) => r.name === name).sort((a, b) => a.spawnedAt - b.spawnedAt);
    for (let k = 1; k <= Math.min(named.length, agents.length); k++) {
      const call = named[named.length - k]!;
      const link: SpawnLink = { ref: agents[agents.length - k]!, messages: [] };
      byCall.set(call.id, link);
      matched.push({ name, at: call.at, link });
    }
  }
  const hidden = new Set<string>();
  if (matched.length === 0) return { byCall, hidden };
  transcript.messages.forEach((m, at) => {
    if (m.role !== "user") return;
    const text = userMessageText(m);
    const parsed = text === null ? null : parseAgentMessage(text);
    if (!parsed) return;
    let owner: (typeof matched)[number] | undefined;
    for (const c of matched) if (c.name === parsed.from && c.at < at && (!owner || c.at > owner.at)) owner = c;
    if (!owner) return;
    owner.link.messages.push({ ...parsed, id: m.id, timestamp: m.timestamp });
    hidden.add(m.id);
  });
  return { byCall, hidden };
}

/** What a spawn card shows (I-084). */
export interface SpawnCardState {
  identity: AgentIdentityView;
  kind: ChipKind;
  label: string;
  running: boolean;
  attention: "warning" | "danger" | null;
  elapsedMs: number;
  /** The agent's task (full text while its session exists, else the call's first line). */
  task: string;
  /** Latest thing it did or said, one line ("" when unknown). */
  latest: string;
  /** Its final report (Markdown) once finished. */
  report: string | null;
  /** The "still open" note of its report, or the reason it exited. */
  note: string | null;
}

export interface SpawnCardInput {
  link: SpawnLink;
  /** Its session while it exists (closed agents' sessions are deleted). */
  session: SessionSummary | undefined;
  /** Its transcript when loaded (live activity). */
  transcript: Transcript | null;
  /** The spawn call's first line of the task. */
  description: string | undefined;
  /** The spawn call is still streaming / running. */
  callActive: boolean;
  now: number;
}

export function spawnCardState({ link, session, transcript, description, callActive, now }: SpawnCardInput): SpawnCardState {
  const { ref, messages } = link;
  const identity = session
    ? sessionAgentIdentity(session)
    : agentIdentity({ id: ref.sessionId, name: ref.name, displayName: ref.displayName, color: ref.color });
  const last = messages.at(-1);
  const finished = [...messages].reverse().find((m) => m.kind === "finished");
  const end = [...messages].reverse().find((m) => m.kind === "finished" || m.kind === "exited");
  let kind: ChipKind;
  let label: string;
  if (session) {
    kind = chipKind(session);
    label = kind === "failed" && session.agent?.status === "closed" ? "Exited" : CHIP_LABELS[kind];
  } else if (end?.kind === "exited") {
    kind = "failed";
    label = "Exited";
  } else if (end) {
    kind = "done";
    label = "Done";
  } else if (callActive) {
    kind = "working";
    label = "Starting";
  } else {
    kind = "done";
    label = "Closed";
  }
  const report = finished?.body.trim() || session?.agent?.result?.trim() || null;
  const running = kind === "working" || kind === "blocked";
  let latest: string;
  if (kind === "blocked") latest = "Waiting for your input";
  else if (kind === "failed" && end?.kind === "exited") latest = agentPreview(end.body);
  else if (kind === "done" && report) latest = agentPreview(report);
  else latest = latestActivity(transcript, sessionCwd(session?.id)) || (last ? agentPreview(last.body) : "") || (running ? "Starting…" : "");
  const start = session?.createdAt ?? ref.spawnedAt;
  const stop = session?.agent?.doneAt ?? (running ? now : (end?.timestamp ?? session?.lastActivityAt ?? last?.timestamp ?? start));
  return {
    identity,
    kind,
    label,
    running,
    attention: kind === "blocked" ? "warning" : kind === "failed" ? "danger" : null,
    elapsedMs: Math.max(0, stop - start),
    task: session?.agent?.task?.trim() || description || "",
    latest,
    report,
    note: end?.kind === "exited" ? end.body.trim() || null : (finished?.note ?? null),
  };
}
