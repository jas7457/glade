/**
 * Sub-agent chips above the composer (I-080, compact chips since I-084): one small chip per
 * sub-agent of a main chat with its colour, fun name, status and latest activity (truncated to
 * `CHIP_TEXT_MAX`). Pure, so the rules are unit-tested; `SubagentStrip.tsx` only renders them.
 *
 * Status comes from `SessionSummary` (status + `agent`, like `agentDisplay`); activity from the
 * sub-agent's transcript when it's loaded (current tool call, else the last reply line).
 */
import type { AssistantMessage, ModelInfo, ModelRef, SessionSummary, ToolCallBlock, Transcript } from "@glade/protocol";
import { agentPreview } from "@/features/chat/AgentMessageCard";
import { sessionAgentIdentity, type AgentIdentityView } from "@/features/chat/agent-identity";
import { summarizeToolCall } from "@/features/chat/tools/summaries";

/**
 * - `working`: running a turn · `blocked`: waiting for the user's input · `done`: reported
 * - `failed`: its last run errored, or its process exited (crashed) · `closing`: closes when its
 *   turn ends · `idle`: between turns
 */
export type ChipKind = "working" | "blocked" | "done" | "failed" | "closing" | "idle";

export interface AgentChip {
  id: string;
  /** Functional name (message_agent id). */
  name: string;
  /** Fun name, role and colour (I-084). */
  identity: AgentIdentityView;
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
  /** `activity` truncated for the chip (full text in its tooltip). */
  shortActivity: string;
  /** First line of its task. */
  task: string;
  /** The report_done summary (Markdown), when done. */
  result: string | null;
}

type ChipSession = Pick<SessionSummary, "id" | "title" | "agentName" | "agentDisplayName" | "agentColor" | "status" | "agent" | "createdAt" | "lastActivityAt" | "lastRunFailed" | "model">;

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

export const CHIP_LABELS: Record<ChipKind, string> = {
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

/** Assistant messages, newest first. */
function assistantsNewestFirst(transcript: Transcript): AssistantMessage[] {
  const out: AssistantMessage[] = [];
  for (let i = transcript.messages.length - 1; i >= 0; i--) {
    const m = transcript.messages[i]!;
    if (m.role === "assistant") out.push(m);
  }
  return out;
}

/** Shown while the newest assistant message is streaming but has only thinking (or nothing) yet. */
export const THINKING_ACTIVITY = "Thinking…";

/**
 * The latest thing a sub-agent did, as one line: a running tool call ("Running `ls`"), else the
 * last line of its latest reply text, else its last tool call (past tense). While the newest
 * assistant message streams with only thinking or nothing yet (pi starts one after every tool
 * result), "Thinking…" (I-130). A finished message without text or calls is skipped. "" when the
 * agent hasn't produced anything (callers show "Starting…" then).
 */
export function latestActivity(transcript: Transcript | null): string {
  if (!transcript) return "";
  for (const message of assistantsNewestFirst(transcript)) {
    const line = messageActivity(transcript, message);
    if (line) return line;
    if (message.streaming) return THINKING_ACTIVITY;
  }
  return "";
}

function messageActivity(transcript: Transcript, message: AssistantMessage): string {
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
      : kind === "failed" && agent?.status === "closed"
        ? "Process stopped"
        : kind === "done" && result
        ? agentPreview(result)
        : latestActivity(transcript) || (kind === "working" ? "Starting…" : "");
  return {
    id: session.id,
    name: session.agentName || session.title || "Sub-agent",
    identity: sessionAgentIdentity(session),
    kind,
    label: agent?.status === "closed" && kind === "failed" ? "Exited" : CHIP_LABELS[kind],
    running: kind === "working" || kind === "blocked",
    attention: kind === "blocked" ? "warning" : kind === "failed" ? "danger" : null,
    elapsedMs: Math.max(0, end - session.createdAt),
    model: shortModelName(session.model, models),
    activity,
    shortActivity: truncateText(activity, CHIP_TEXT_MAX),
    task: firstLine(agent?.task),
    result,
  };
}

/** Longest activity text on a chip (characters, incl. the ellipsis). */
export const CHIP_TEXT_MAX = 28;

/** `text` on one line, cut to `max` characters with an ellipsis (at a word break when close). */
export function truncateText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
