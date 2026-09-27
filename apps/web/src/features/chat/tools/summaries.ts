/**
 * One-line summaries for tool calls ("Ran `ls -la`", "Read src/app.ts"...). Pure; keyed by
 * tool name so new tools are one entry away. Unknown tools fall back to name + arg preview.
 */
import type { ToolCallBlock } from "@glade/protocol";

export interface ToolSummary {
  /** Leading verb, e.g. "Ran" / "Running". */
  verb: string;
  /** What the verb applies to (command, path, pattern...). May be empty. */
  subject: string;
  /** Render the subject in monospace (commands, patterns, paths). */
  mono: boolean;
}

type Args = Record<string, unknown>;
type Summarizer = (args: Args, active: boolean) => ToolSummary;

const MAX_SUBJECT = 120;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export function truncate(text: string, max = MAX_SUBJECT): string {
  const oneLine = text.replace(/\s*\n\s*/g, " ⏎ ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

const verb = (active: boolean, past: string, present: string) => (active ? present : past);

export const toolSummarizers: Record<string, Summarizer> = {
  bash: (a, active) => ({ verb: verb(active, "Ran", "Running"), subject: truncate(str(a.command) ?? ""), mono: true }),
  read: (a, active) => {
    const range =
      typeof a.offset === "number" ? `:${a.offset}${typeof a.limit === "number" ? `-${a.offset + a.limit - 1}` : ""}` : "";
    return { verb: verb(active, "Read", "Reading"), subject: `${str(a.path) ?? ""}${range}`, mono: true };
  },
  write: (a, active) => ({ verb: verb(active, "Wrote", "Writing"), subject: str(a.path) ?? "", mono: true }),
  edit: (a, active) => ({ verb: verb(active, "Edited", "Editing"), subject: str(a.path) ?? "", mono: true }),
  grep: (a, active) => ({
    verb: verb(active, "Searched", "Searching"),
    subject: truncate(`${str(a.pattern) ?? ""}${str(a.path) ? ` in ${str(a.path)}` : ""}${str(a.glob) ? ` (${str(a.glob)})` : ""}`),
    mono: true,
  }),
  find: (a, active) => ({
    verb: verb(active, "Searched", "Searching"),
    subject: truncate(`${str(a.pattern) ?? ""}${str(a.path) ? ` in ${str(a.path)}` : ""}`),
    mono: true,
  }),
  ls: (a, active) => ({ verb: verb(active, "Listed", "Listing"), subject: str(a.path) ?? ".", mono: true }),
};

/** Preview of arbitrary args: string/number values joined, truncated. */
export function argsPreview(args: Args): string {
  const values = Object.values(args)
    .filter((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .map(String);
  return truncate(values.join(" "), 80);
}

/**
 * Best-effort extraction of complete string fields from partial JSON (tool args while they
 * are still streaming), so e.g. a bash command can be shown before the call is complete.
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

export function summarizeToolCall(call: Pick<ToolCallBlock, "name" | "args" | "argsText">, active: boolean): ToolSummary {
  const args = call.args ?? partialArgs(call.argsText);
  const summarizer = toolSummarizers[call.name];
  if (summarizer) return summarizer(args, active);
  return { verb: call.name, subject: argsPreview(args), mono: false };
}

/** Header for a collapsed group of calls. */
export function groupLabel(count: number, active: boolean): string {
  const noun = count === 1 ? "tool call" : "tool calls";
  return active ? `Running ${count} ${noun}…` : `Ran ${count} ${noun}`;
}
