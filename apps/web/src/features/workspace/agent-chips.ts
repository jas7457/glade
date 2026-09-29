/**
 * Sub-agent chips above the composer (I-080, compact chips since I-084): one small chip per
 * sub-agent of a main chat with its colour, fun name, status and latest activity (truncated to
 * `CHIP_TEXT_MAX`). Pure, so the rules are unit-tested; `SubagentStrip.tsx` only renders them.
 *
 * Status comes from `SessionSummary` (status + `agent`, like `agentDisplay`); activity from the
 * sub-agent's transcript when it's loaded (current tool call, else the last reply line), in words
 * rather than raw tool names (I-148). The tooltip leads with its short generated title (I-148),
 * else its functional name and the task's first sentence.
 */
import type { AssistantMessage, ModelInfo, ModelRef, SessionSummary, ToolCallBlock, Transcript } from "@glade/protocol";
import { agentPreview } from "@/features/chat/AgentMessageCard";
import { sessionAgentIdentity, type AgentIdentityView } from "@/features/chat/agent-identity";
import { formatDuration } from "@/features/chat/duration";
import { summarizeToolCall } from "@/features/chat/tools/summaries";
import { homeOf } from "@/lib/paths";
import { sessionsById, workspacesById } from "@/state/store";

/** The folder a session's chat works in (its workspace's cwd), for relative tool paths (I-158). */
export function sessionCwd(sessionId: string | null | undefined): string | null {
  const session = sessionId ? sessionsById.value.get(sessionId) : undefined;
  return session ? (workspacesById.value.get(session.workspaceId)?.cwd ?? null) : null;
}

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
  /** Its short title (generated from the task, or the user's rename), or null while there's none (I-148). */
  title: string | null;
  /** What it works on, for the tooltip: the title, else "<functional name>: <task's first sentence>". */
  summary: string;
  /** The report_done summary (Markdown), when done. */
  result: string | null;
}

type ChipSession = Pick<SessionSummary, "id" | "title" | "titleSource" | "agentName" | "agentDisplayName" | "agentColor" | "status" | "agent" | "createdAt" | "lastActivityAt" | "lastRunFailed" | "model">;

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
export function latestActivity(transcript: Transcript | null, cwd?: string | null): string {
  if (!transcript) return "";
  for (const message of assistantsNewestFirst(transcript)) {
    const line = messageActivity(transcript, message, cwd ?? null);
    if (line) return line;
    if (message.streaming) return THINKING_ACTIVITY;
  }
  return "";
}

function messageActivity(transcript: Transcript, message: AssistantMessage, cwd: string | null): string {
  const blocks = message.content;
  const calls = blocks.filter((b): b is ToolCallBlock => b.type === "toolCall");
  const running = [...calls].reverse().find((c) => {
    const r = transcript.toolResults[c.id];
    return r ? r.status === "running" : message.streaming;
  });
  if (running) return summaryLine(running, true, cwd);
  // Whichever came last: reply text or a finished tool call (thinking blocks are skipped).
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.type === "text" && b.text.trim()) return lastLine(b.text);
    if (b.type === "toolCall") return summaryLine(b, false, cwd);
  }
  return "";
}

function summaryLine(call: ToolCallBlock, active: boolean, cwd: string | null): string {
  if (call.kind === "other") return toolInWords(call.name, active);
  const s = summarizeToolCall(call, active, undefined, cwd ? { cwd, home: homeOf(cwd) } : undefined);
  if (call.kind === "shell" && !s.subject) return active ? "Running a command" : "Ran a command";
  return [s.verb, s.subject].filter(Boolean).join(" ");
}

/** Tools without a canonical kind, by name: [past, present] (I-148). */
const TOOL_WORDS: Record<string, [string, string]> = {
  report_done: ["Reported back", "Reporting back"],
  spawn_agent: ["Started an agent", "Starting an agent"],
  message_agent: ["Messaged an agent", "Messaging an agent"],
  list_agents: ["Listed agents", "Listing agents"],
  close_agent: ["Closed an agent", "Closing an agent"],
  bash: ["Ran a command", "Running a command"],
  todowrite: ["Updated the to-do list", "Updating the to-do list"],
  todo_write: ["Updated the to-do list", "Updating the to-do list"],
  ask_user: ["Asked you a question", "Asking you a question"],
};

/**
 * A tool call in words, by the tool's name: known agent tools ("Reporting back"), else the name
 * humanized (`mcp__pi__run_checks` / `runChecks` → "Run checks"). Raw args aren't shown.
 */
export function toolInWords(name: string, active: boolean): string {
  const base = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  const words = TOOL_WORDS[base.toLowerCase()];
  if (words) return active ? words[1] : words[0];
  const human = base
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-\s]+/g, " ")
    .trim()
    .toLowerCase();
  return human ? human[0]!.toUpperCase() + human.slice(1) : "Using a tool";
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
        : latestActivity(transcript, sessionCwd(session.id)) || (kind === "working" ? "Starting…" : "");
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
    title: agentTitle(session),
    summary: agentTitle(session) ?? taskSummary(session.agentName || session.title || "Sub-agent", agent?.task),
    result,
  };
}

/** A title other than its functional name: generated from its task, or the user's rename (I-148). */
export function agentTitle(session: Pick<ChipSession, "title" | "agentName">): string | null {
  const title = session.title?.trim();
  return title && title !== session.agentName ? title : null;
}

/** Longest task sentence in the fallback summary (characters, incl. the ellipsis). */
export const TASK_SUMMARY_MAX = 100;

/** "<name>: <the first sentence of the task's first line, cut at ~100 chars>" (or just the name without a task). */
export function taskSummary(name: string, task: string | null | undefined): string {
  const flat = firstLine(task).replace(/\s+/g, " ");
  const sentence = /^.+?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
  return sentence ? `${name}: ${truncateText(sentence, TASK_SUMMARY_MAX)}` : name;
}

/**
 * The chip's tooltip (I-148): "<Name> · <summary> — <status> · <time> · <model>", then what it's
 * doing ("Now: …" while it runs, else "Latest: …"), then the click hint.
 */
export function chipTooltip(chip: AgentChip, selected: boolean): string {
  const live = chip.kind === "working" || chip.kind === "blocked" || chip.kind === "closing";
  return [
    `${chip.identity.displayName} · ${chip.summary} — ${chip.label} · ${formatDuration(chip.elapsedMs)}${chip.model ? ` · ${chip.model}` : ""}`,
    chip.activity && `${live ? "Now" : "Latest"}: ${chip.activity}`,
    selected ? "Click to hide" : "Click to open",
  ]
    .filter(Boolean)
    .join("\n");
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
