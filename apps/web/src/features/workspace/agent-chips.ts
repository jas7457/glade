/**
 * Sub-agent summary strip state (I-080): one chip per sub-agent of a main chat (status, elapsed
 * time, short model name, latest one-line activity, task, report) and the strip's summary line
 * ("3 agents · 2 working · 1 done"). Pure, so the rules are unit-tested; the strip
 * (`SubagentStrip.tsx`) only renders them.
 *
 * Status comes from `SessionSummary` (status + `agent`, like `agentDisplay`); activity from the
 * sub-agent's transcript when it's loaded (current tool call, else the last reply line).
 */
import type { AssistantMessage, ModelInfo, ModelRef, SessionSummary, ToolCallBlock, Transcript } from "@glade/protocol";
import { agentPreview } from "@/features/chat/AgentMessageCard";
import { summarizeToolCall } from "@/features/chat/tools/summaries";

/**
 * - `working`: running a turn · `blocked`: waiting for the user's input · `done`: reported
 * - `failed`: its last run errored, or its process exited (crashed) · `closing`: closes when its
 *   turn ends · `idle`: between turns
 */
export type ChipKind = "working" | "blocked" | "done" | "failed" | "closing" | "idle";

export interface AgentChip {
  id: string;
  name: string;
  kind: ChipKind;
  /** Short status label, e.g. "Needs input". */
  label: string;
  /** Still counts as running (for "Stop all"). */
  running: boolean;
  /** Needs the user's attention (highlighted chip). */
  attention: "warning" | "danger" | null;
  /** Elapsed ms since it was spawned (until done, or now while it works). */
  elapsedMs: number;
  /** Short model name ("Sonnet 4.5"), or null. */
  model: string | null;
  /** Latest one-line activity ("Running `pnpm test`", last reply line, report), or "". */
  activity: string;
  /** First line of its task. */
  task: string;
  /** The report_done summary (Markdown), when done. */
  result: string | null;
}

type ChipSession = Pick<SessionSummary, "id" | "title" | "agentName" | "status" | "agent" | "createdAt" | "lastActivityAt" | "lastRunFailed" | "model">;

export function chipKind(session: ChipSession): ChipKind {
  const agent = session.agent;
  if (session.status === "blocked") return "blocked";
  if (agent?.closing) return "closing";
  if (agent?.status === "closed") return "failed";
  if (session.status === "working" || agent?.status === "working") return "working";
  if (session.lastRunFailed) return "failed";
  if (agent?.status === "done") return "done";
  return "idle";
}

const LABELS: Record<ChipKind, string> = {
  working: "Working",
  blocked: "Needs input",
  done: "Done",
  failed: "Failed",
  closing: "Closing",
  idle: "Idle",
};

/** "Claude Sonnet 4.5" → "Sonnet 4.5"; unknown models: the id without a `claude-` prefix. */
export function shortModelName(ref: ModelRef | null | undefined, models: readonly ModelInfo[]): string | null {
  if (!ref) return null;
  const info = models.find((m) => m.id === ref.id && m.provider === ref.provider) ?? models.find((m) => m.id === ref.id);
  if (info?.name) return info.name.replace(/^claude\s+/i, "").trim() || info.name;
  return ref.id.replace(/^claude-/i, "");
}

/** First non-empty line of a text (trimmed). */
export function firstLine(text: string | null | undefined): string {
  return (text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

function lastAssistant(transcript: Transcript): AssistantMessage | null {
  for (let i = transcript.messages.length - 1; i >= 0; i--) {
    const m = transcript.messages[i]!;
    if (m.role === "assistant") return m;
  }
  return null;
}

/**
 * The latest thing a sub-agent did, as one line: a running tool call ("Running `ls`"), else the
 * last line of its latest reply text, else its last tool call (past tense). "" when unknown.
 */
export function latestActivity(transcript: Transcript | null): string {
  if (!transcript) return "";
  const message = lastAssistant(transcript);
  if (!message) return "";
  const blocks = message.content;
  const calls = blocks.filter((b): b is ToolCallBlock => b.type === "toolCall");
  const running = [...calls].reverse().find((c) => {
    const r = transcript.toolResults[c.id];
    return r ? r.status === "running" : message.streaming;
  });
  if (running) return summaryLine(running, true);
  // Whichever came last: reply text or a finished tool call (thinking blocks are skipped).
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.type === "text" && b.text.trim()) return lastLine(b.text);
    if (b.type === "toolCall") return summaryLine(b, false);
  }
  return "";
}

function summaryLine(call: ToolCallBlock, active: boolean): string {
  const s = summarizeToolCall(call, active);
  return [s.verb, s.subject].filter(Boolean).join(" ");
}

function lastLine(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim() && !/^\s*(```|---+\s*$)/.test(l));
  return agentPreview(lines[lines.length - 1] ?? "");
}

export function agentChip(session: ChipSession, transcript: Transcript | null, models: readonly ModelInfo[], now: number): AgentChip {
  const kind = chipKind(session);
  const agent = session.agent;
  const result = agent?.result?.trim() || null;
  const end = agent?.doneAt ?? (kind === "working" || kind === "blocked" ? now : session.lastActivityAt);
  const activity =
    kind === "blocked"
      ? "Waiting for your input"
      : kind === "done" && result
        ? agentPreview(result)
        : latestActivity(transcript) || (kind === "working" ? "Starting…" : "");
  return {
    id: session.id,
    name: session.agentName || session.title || "Sub-agent",
    kind,
    label: agent?.status === "closed" && kind === "failed" ? "Exited" : LABELS[kind],
    running: kind === "working" || kind === "blocked",
    attention: kind === "blocked" ? "warning" : kind === "failed" ? "danger" : null,
    elapsedMs: Math.max(0, end - session.createdAt),
    model: shortModelName(session.model, models),
    activity,
    task: firstLine(agent?.task),
    result,
  };
}

/** "3 agents · 2 working · 1 done" (only non-zero counts; order: attention first). */
export function stripSummary(chips: readonly Pick<AgentChip, "kind">[]): string {
  const count = (k: ChipKind) => chips.filter((c) => c.kind === k).length;
  const parts = [`${chips.length} ${chips.length === 1 ? "agent" : "agents"}`];
  const add = (n: number, label: string) => n > 0 && parts.push(`${n} ${label}`);
  add(count("blocked"), count("blocked") === 1 ? "needs input" : "need input");
  add(count("failed"), "failed");
  add(count("working"), "working");
  add(count("done"), "done");
  add(count("idle") + count("closing"), "idle");
  return parts.join(" · ");
}

/** The strip starts collapsed to its summary line from this many agents on. */
export const COLLAPSE_FROM = 3;
