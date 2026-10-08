/**
 * The demo scenario player (I-209), pure part: turns a scripted agent turn (thinking, text, tool
 * calls, sub-agent spawns, a report) into a timed list of actions the demo session plays back:
 * `AgentEvent`s to emit, waits between them, and effects (write a file, spawn a sub-agent, report).
 *
 *   const actions = compileTurn(turn.steps, { nextId, files, pace: LIVE_PACE });
 *   // [{ type: "emit", event: { type: "message_start", … } }, { type: "wait", ms: 20 }, …]
 *
 * Text streams in token-sized chunks; tool calls appear one by one, run "in parallel" and finish
 * in order of their duration; edits get a real diff computed against the file's current content
 * (`files.read`), and later edits in the same turn see the earlier ones. Nothing here touches the
 * disk or the clock: the session (demo-harness.ts) does the I/O and fills in timestamps.
 */
import type { AgentEvent, ContentBlock, DiffLine, ModelRef, ToolCallBlock, ToolEdit, ToolInput, ToolKind, ToolResult } from "@glade/protocol";

/** One tool call of a scripted step. */
export interface DemoTool {
  kind: ToolKind;
  /** The harness's tool name ("read", "Read", "shell"). */
  name: string;
  input: ToolInput;
  /** Raw args (default: built from `input`). */
  args?: Record<string, unknown>;
  /** What the tool printed (default: derived for read/edit/write). */
  output?: string;
  /** How long it runs (ms, live pace). */
  ms?: number;
  /** It failed (status error). */
  error?: boolean;
}

/** A sub-agent spawned through Glade's agent API. */
export interface DemoSpawn {
  /** Agent name (also the key of its sub-agent script). */
  name: string;
  task: string;
}

export type DemoStep =
  | { think: string }
  | { say: string }
  | { tools: DemoTool[] }
  | { spawn: DemoSpawn[] }
  | { pause: number }
  /** Sub-agents: report_done with this summary (a tool call + the API call). */
  | { report: string };

export type DemoAction =
  | { type: "wait"; ms: number }
  | { type: "emit"; event: AgentEvent }
  /** Write `content` to `path` (relative to the chat's folder). */
  | { type: "write"; path: string; content: string }
  | { type: "spawn"; name: string; task: string }
  | { type: "report"; summary: string };

/** Streaming speed. All waits are multiplied by `scale` (0 = instant, used when seeding history). */
export interface DemoPace {
  /** Characters per streamed text chunk (roughly a token or two). */
  chunkChars: number;
  /** ms between text chunks. */
  chunkMs: number;
  /** ms between thinking chunks. */
  thinkChunkMs: number;
  /** ms between tool calls appearing in one message. */
  toolGapMs: number;
  /** Default tool duration (ms). */
  toolMs: number;
  /** ms before the first block of a message (time to first token). */
  firstTokenMs: number;
  scale: number;
}

/** Realistic live pace: ~300 chars/s text, thinking a little faster. */
export const LIVE_PACE: DemoPace = { chunkChars: 6, chunkMs: 20, thinkChunkMs: 14, toolGapMs: 220, toolMs: 600, firstTokenMs: 450, scale: 1 };
/** Seeding history: everything at once. */
export const INSTANT_PACE: DemoPace = { ...LIVE_PACE, scale: 0 };

/** File contents as the turn sees them (the chat's folder). */
export interface DemoFiles {
  read(path: string): string | null;
}

export interface CompileOptions {
  nextId: () => string;
  files: DemoFiles;
  pace: DemoPace;
  model?: ModelRef | null;
}

/** Splits text into stream chunks of about `size` characters, on word boundaries where it can. */
export function chunkText(text: string, size: number): string[] {
  const words = text.match(/\S+\s*|\s+/g) ?? [];
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    if (current && current.length + word.length > size) {
      chunks.push(current);
      current = "";
    }
    if (word.length > size * 2) {
      for (let i = 0; i < word.length; i += size) chunks.push(word.slice(i, i + size));
      continue;
    }
    current += word;
  }
  if (current) chunks.push(current);
  return chunks;
}

const lines = (text: string) => (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");

/**
 * The diff of replacing `edit.oldText` with `edit.newText` in `before` (3 lines of context), with
 * real line numbers when `oldText` is found; else the plain replacement from line 1.
 */
export function editDiff(before: string | null, edit: ToolEdit, context = 3): DiffLine[] {
  const at = before?.indexOf(edit.oldText) ?? -1;
  const oldLines = lines(edit.oldText);
  const newLines = lines(edit.newText);
  if (before === null || at < 0) {
    return [
      ...oldLines.map((text, i): DiffLine => ({ type: "del", text, oldLine: i + 1 })),
      ...newLines.map((text, i): DiffLine => ({ type: "add", text, newLine: i + 1 })),
    ];
  }
  const all = before.split("\n");
  const start = before.slice(0, at).split("\n").length - 1; // 0-based first changed line
  const end = start + oldLines.length; // exclusive
  const out: DiffLine[] = [];
  const from = Math.max(0, start - context);
  if (from > 0) out.push({ type: "gap", text: "" });
  for (let i = from; i < start; i++) out.push({ type: "context", text: all[i]!, oldLine: i + 1, newLine: i + 1 });
  // Lines shared at the start/end of old and new are context, not churn.
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++;
  let tail = 0;
  while (tail < oldLines.length - head && tail < newLines.length - head && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++;
  for (let i = 0; i < head; i++) out.push({ type: "context", text: oldLines[i]!, oldLine: start + i + 1, newLine: start + i + 1 });
  for (let i = head; i < oldLines.length - tail; i++) out.push({ type: "del", text: oldLines[i]!, oldLine: start + i + 1 });
  for (let i = head; i < newLines.length - tail; i++) out.push({ type: "add", text: newLines[i]!, newLine: start + i + 1 });
  const shift = newLines.length - oldLines.length;
  for (let i = tail; i > 0; i--) {
    const o = oldLines.length - i;
    out.push({ type: "context", text: oldLines[o]!, oldLine: start + o + 1, newLine: start + o + 1 + shift });
  }
  const to = Math.min(all.length, end + context);
  for (let i = end; i < to; i++) out.push({ type: "context", text: all[i]!, oldLine: i + 1, newLine: i + 1 + shift });
  if (to < all.length) out.push({ type: "gap", text: "" });
  return out;
}

/** A new file: every line added. */
export function writeDiff(content: string): DiffLine[] {
  return lines(content).map((text, i) => ({ type: "add", text, newLine: i + 1 }));
}

/** Raw args in the shape the named tool takes (for the "other"/details views). */
function defaultArgs(tool: DemoTool): Record<string, unknown> {
  const { input } = tool;
  switch (tool.kind) {
    case "shell":
      return { command: input.command };
    case "read":
      return { path: input.path, ...(input.offset ? { offset: input.offset } : {}), ...(input.limit ? { limit: input.limit } : {}) };
    case "edit":
      return { path: input.path, edits: input.edits };
    case "write":
      return { path: input.path, content: input.content };
    case "search":
      return { pattern: input.pattern, ...(input.path ? { path: input.path } : {}), ...(input.glob ? { glob: input.glob } : {}) };
    default:
      return { ...input };
  }
}

/** Numbered lines like pi's read tool prints them (the window asked for). */
function readOutput(content: string | null, input: ToolInput): string {
  if (content === null) return `File not found: ${input.path}`;
  const all = lines(content);
  const from = Math.max(1, input.offset ?? 1);
  const to = input.limit ? Math.min(all.length, from + input.limit - 1) : all.length;
  return all.slice(from - 1, to).join("\n") + "\n";
}

/** Compiles one turn's steps into actions (see the header). */
export function compileTurn(steps: DemoStep[], options: CompileOptions): DemoAction[] {
  const { nextId, files, pace, model } = options;
  const out: DemoAction[] = [];
  const overlay = new Map<string, string>();
  const read = (path: string) => (overlay.has(path) ? overlay.get(path)! : files.read(path));
  const wait = (ms: number) => {
    const scaled = Math.round(ms * pace.scale);
    if (scaled > 0) out.push({ type: "wait", ms: scaled });
  };
  const emit = (event: AgentEvent) => out.push({ type: "emit", event });
  const meta = model ? { provider: model.provider, model: model.id } : {};

  let message: { id: string; content: ContentBlock[] } | null = null;
  const open = () => {
    if (message) return message;
    message = { id: nextId(), content: [] };
    emit({ type: "message_start", message: { id: message.id, role: "assistant", content: [], timestamp: 0, streaming: true, ...meta } });
    wait(pace.firstTokenMs);
    return message;
  };
  const close = (stopReason: "stop" | "toolUse") => {
    if (!message) return;
    emit({ type: "message_end", message: { id: message.id, role: "assistant", content: message.content, timestamp: 0, stopReason, ...meta } });
    message = null;
  };
  const stream = (type: "text" | "thinking", text: string) => {
    const m = open();
    const index = m.content.length;
    m.content.push({ type, text });
    emit({ type: "block_start", messageId: m.id, index, block: { type, text: "" } });
    for (const delta of chunkText(text, pace.chunkChars)) {
      emit({ type: "block_delta", messageId: m.id, index, delta });
      wait(type === "thinking" ? pace.thinkChunkMs : pace.chunkMs);
    }
    emit({ type: "block_end", messageId: m.id, index, block: { type, text } });
  };
  /** Adds tool calls to the open message, ends it, runs them; `effects` run before each one ends. */
  const runTools = (calls: Array<{ block: ToolCallBlock; result: Omit<ToolResult, "toolCallId" | "toolName">; ms: number; effects: DemoAction[] }>) => {
    const m = open();
    calls.forEach((call, i) => {
      if (i > 0) wait(pace.toolGapMs);
      const index = m.content.length;
      m.content.push(call.block);
      emit({ type: "block_start", messageId: m.id, index, block: { ...call.block, input: undefined, args: undefined } });
      emit({ type: "block_delta", messageId: m.id, index, delta: JSON.stringify(call.block.args), input: call.block.input });
      emit({ type: "block_end", messageId: m.id, index, block: call.block });
    });
    close("toolUse");
    for (const call of calls) emit({ type: "tool_start", toolCallId: call.block.id, toolName: call.block.name, args: call.block.args });
    // Parallel: each ends after its own duration, shortest first (stable for ties).
    const order = calls.map((c, i) => ({ c, i })).sort((a, b) => a.c.ms - b.c.ms || a.i - b.i);
    let elapsed = 0;
    for (const { c } of order) {
      wait(c.ms - elapsed);
      elapsed = c.ms;
      out.push(...c.effects);
      emit({ type: "tool_end", toolCallId: c.block.id, result: { toolCallId: c.block.id, toolName: c.block.name, ...c.result } });
    }
  };

  for (const step of steps) {
    if ("think" in step) stream("thinking", step.think);
    else if ("say" in step) stream("text", step.say);
    else if ("pause" in step) wait(step.pause);
    else if ("tools" in step) {
      runTools(
        step.tools.map((tool) => {
          const id = `call_${nextId()}`;
          const args = tool.args ?? defaultArgs(tool);
          const block: ToolCallBlock = { type: "toolCall", id, name: tool.name, kind: tool.kind, input: tool.input, args };
          const effects: DemoAction[] = [];
          let output = tool.output;
          let diff: DiffLine[] | undefined;
          const path = tool.input.path;
          if (tool.kind === "read" && path) output ??= readOutput(read(path), tool.input);
          if (tool.kind === "edit" && path && tool.input.edits && !tool.error) {
            let content = read(path);
            diff = [];
            for (const edit of tool.input.edits) {
              diff.push(...editDiff(content, edit));
              if (content !== null && content.includes(edit.oldText)) content = content.replace(edit.oldText, edit.newText);
            }
            if (content !== null) {
              overlay.set(path, content);
              effects.push({ type: "write", path, content });
            }
            output ??= `Successfully replaced ${tool.input.edits.length} block${tool.input.edits.length === 1 ? "" : "s"} in ${path}.`;
          }
          if (tool.kind === "write" && path && tool.input.content !== undefined && !tool.error) {
            overlay.set(path, tool.input.content);
            effects.push({ type: "write", path, content: tool.input.content });
            diff = writeDiff(tool.input.content);
            output ??= `Wrote ${lines(tool.input.content).length} lines to ${path}.`;
          }
          const result = { status: tool.error ? ("error" as const) : ("done" as const), output: output ?? "", ...(diff ? { diff } : {}) };
          return { block, result, ms: tool.ms ?? pace.toolMs, effects };
        }),
      );
    } else if ("spawn" in step) {
      runTools(
        step.spawn.map((agent) => {
          const id = `call_${nextId()}`;
          const args = { name: agent.name, task: agent.task };
          const block: ToolCallBlock = {
            type: "toolCall",
            id,
            name: "spawn_agent",
            kind: "task",
            input: { agentName: agent.name, description: agent.task.split("\n")[0] },
            args,
          };
          return { block, result: { status: "done", output: `Spawned ${agent.name}.` }, ms: 900, effects: [{ type: "spawn", name: agent.name, task: agent.task }] };
        }),
      );
    } else if ("report" in step) {
      const id = `call_${nextId()}`;
      const block: ToolCallBlock = { type: "toolCall", id, name: "report_done", kind: "other", args: { summary: step.report } };
      runTools([{ block, result: { status: "done", output: "Reported to main." }, ms: 300, effects: [{ type: "report", summary: step.report }] }]);
    }
  }
  close("stop");
  return out;
}

/** Total play time of compiled actions (ms). */
export function duration(actions: DemoAction[]): number {
  return actions.reduce((sum, a) => sum + (a.type === "wait" ? a.ms : 0), 0);
}
