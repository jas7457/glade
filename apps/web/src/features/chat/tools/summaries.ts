/**
 * One-line summaries for tool calls ("Ran `ls -la`", "Read src/app.ts"...). Pure; keyed by the
 * canonical tool kind and reading only the normalized input (I-068). `other` tools fall back to
 * the harness's tool name + a preview of the raw args.
 */
import type { ToolCallBlock, ToolInput, ToolKind } from "@glade/protocol";

export interface ToolSummary {
  /** Leading verb, e.g. "Ran" / "Running". */
  verb: string;
  /** What the verb applies to (command, path, pattern...). May be empty. */
  subject: string;
  /** Render the subject in monospace (commands, patterns, paths). */
  mono: boolean;
}

type Args = Record<string, unknown>;
type Summarizer = (input: ToolInput, active: boolean) => ToolSummary;

const MAX_SUBJECT = 120;

export function truncate(text: string, max = MAX_SUBJECT): string {
  const oneLine = text.replace(/\s*\n\s*/g, " ⏎ ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

const verb = (active: boolean, past: string, present: string) => (active ? present : past);

/** Summaries per canonical kind; `other` has none (name + raw args preview). */
export const toolSummarizers: Record<Exclude<ToolKind, "other">, Summarizer> = {
  shell: (i, active) => ({ verb: verb(active, "Ran", "Running"), subject: truncate(i.command ?? ""), mono: true }),
  read: (i, active) => {
    const range = i.offset !== undefined ? `:${i.offset}${i.limit !== undefined ? `-${i.offset + i.limit - 1}` : ""}` : "";
    return { verb: verb(active, "Read", "Reading"), subject: `${i.path ?? ""}${range}`, mono: true };
  },
  write: (i, active) => ({ verb: verb(active, "Wrote", "Writing"), subject: i.path ?? "", mono: true }),
  edit: (i, active) => ({ verb: verb(active, "Edited", "Editing"), subject: i.path ?? "", mono: true }),
  search: (i, active) => ({
    verb: verb(active, "Searched", "Searching"),
    subject: truncate(`${i.pattern ?? ""}${i.path ? ` in ${i.path}` : ""}${i.glob ? ` (${i.glob})` : ""}`),
    mono: true,
  }),
  list: (i, active) => ({ verb: verb(active, "Listed", "Listing"), subject: i.path ?? ".", mono: true }),
  web: (i, active) =>
    i.url
      ? { verb: verb(active, "Fetched", "Fetching"), subject: truncate(i.url), mono: true }
      : { verb: verb(active, "Searched the web for", "Searching the web for"), subject: truncate(i.query ?? ""), mono: false },
  task: (i, active) => ({ verb: verb(active, "Ran task", "Running task"), subject: truncate(i.description ?? ""), mono: false }),
};

/** Preview of arbitrary args: string/number values joined, truncated. */
export function argsPreview(args: Args): string {
  const values = Object.values(args)
    .filter((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .map(String);
  return truncate(values.join(" "), 80);
}

/**
 * Best-effort extraction of complete string fields from partial JSON: the raw args of an
 * `other` tool while they are still streaming (known kinds get a normalized `input` instead).
 */
export function partialArgs(argsText: string | undefined): Args {
  if (!argsText) return {};
  try {
    const parsed: unknown = JSON.parse(argsText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Args;
  } catch {
    /* incomplete - fall through */
  }
  const out: Args = {};
  const re = /"([A-Za-z_][\w]*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  for (const m of argsText.matchAll(re)) {
    try {
      out[m[1]!] = JSON.parse(`"${m[2]!}"`) as string;
    } catch {
      /* skip */
    }
  }
  return out;
}

export function summarizeToolCall(call: Pick<ToolCallBlock, "name" | "kind" | "input" | "args" | "argsText">, active: boolean): ToolSummary {
  // Looked up defensively: a kind this build doesn't know renders like `other`.
  const summarizer = call.kind === "other" ? undefined : (toolSummarizers[call.kind] as Summarizer | undefined);
  if (summarizer) return summarizer(call.input ?? {}, active);
  return { verb: call.name, subject: argsPreview(call.args ?? partialArgs(call.argsText)), mono: false };
}

/** Header for a collapsed group of calls. */
export function groupLabel(count: number, active: boolean): string {
  const noun = count === 1 ? "tool call" : "tool calls";
  return active ? `Running ${count} ${noun}…` : `Ran ${count} ${noun}`;
}
