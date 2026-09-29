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
/** `output` is the call's result text once it has one (only the chat tools read it). */
type Summarizer = (input: ToolInput, active: boolean, output?: string) => ToolSummary;

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
      : i.query !== undefined || i.description === undefined
        ? { verb: verb(active, "Searched the web for", "Searching the web for"), subject: truncate(i.query ?? ""), mono: false }
        : { verb: verb(active, "Read web results", "Reading web results"), subject: truncate(i.description), mono: false },
  // A spawned sub-agent reads by its name, not its (long) task (I-145); other harnesses' tasks by their description.
  task: (i, active) =>
    i.agentName
      ? { verb: verb(active, "Started agent", "Starting agent"), subject: i.agentName, mono: false }
      : { verb: verb(active, "Ran task", "Running task"), subject: truncate(i.description ?? ""), mono: false },
  agent: (i, active) => {
    if (i.agentAction === "list") return { verb: verb(active, "Listed agents", "Listing agents"), subject: "", mono: false };
    if (i.agentAction === "close") return { verb: verb(active, "Closed", "Closing"), subject: i.agentName ?? "", mono: false };
    const text = i.description ? `: ${i.description}` : "";
    return { verb: verb(active, "Messaged", "Messaging"), subject: truncate(`${i.agentName ?? ""}${text}`), mono: false };
  },
  mcp: (i, active) => {
    if (i.tool) return { verb: verb(active, "Called", "Calling"), subject: i.server ? `${i.server} › ${i.tool}` : i.tool, mono: true };
    if (i.query) return { verb: verb(active, "Searched MCP tools for", "Searching MCP tools for"), subject: truncate(i.query), mono: false };
    if (i.description === "script") return { verb: verb(active, "Ran MCP script", "Running MCP script"), subject: "", mono: false };
    return { verb: "MCP", subject: truncate([i.server, i.description].filter(Boolean).join(" · ")), mono: false };
  },
  chat: (i, active, output) => {
    if (i.chatAction === "find") {
      const query = i.query ? `"${truncate(i.query)}"` : "";
      const count = active ? undefined : foundChats(output);
      if (count === undefined) return { verb: verb(active, "Searched chats for", "Searching chats for"), subject: query, mono: false };
      return { verb: `Found ${count === 0 ? "no" : count} ${count === 1 ? "chat" : "chats"} for`, subject: query, mono: false };
    }
    const title = active ? undefined : chatTitle(output);
    const subject = title ? `"${truncate(title)}"` : (i.chatId ?? "");
    if (i.chatAction === "open") {
      const hidden = !active && !!output?.startsWith("No Glade window is open");
      return { verb: hidden ? "No window to show chat" : verb(active, "Opened chat", "Opening chat"), subject, mono: !title };
    }
    return { verb: verb(active, "Read chat", "Reading chat"), subject, mono: !title };
  },
};

/**
 * Chat tools' results (ext-kit agent-teams, I-099): `N chat(s) (…):` / `No chats found for "…".`
 * from find_chats; read_chat starts with `"<title>" — …`, open_chat says `Opened "<title>" in
 * Glade.` (or `No Glade window is open; "<title>" will not be shown…`).
 */
function foundChats(output: string | undefined): number | undefined {
  if (!output) return undefined;
  if (output.startsWith("No chats found for ")) return 0;
  const m = /^(\d+) chat\(s\)/.exec(output);
  return m ? Number(m[1]) : undefined;
}

function chatTitle(output: string | undefined): string | undefined {
  const first = output?.split("\n", 1)[0] ?? "";
  const m = /^"(.+)" — /.exec(first) ?? /^Opened "(.+)" in Glade\.$/.exec(first) ?? /^No Glade window is open; "(.+)" will not be shown/.exec(first);
  return m?.[1] || undefined;
}

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

export function summarizeToolCall(
  call: Pick<ToolCallBlock, "name" | "kind" | "input" | "args" | "argsText">,
  active: boolean,
  /** The result's text, when the call has one (a few kinds summarize what they found). */
  output?: string,
): ToolSummary {
  // Looked up defensively: a kind this build doesn't know renders like `other`.
  const summarizer = call.kind === "other" ? undefined : (toolSummarizers[call.kind] as Summarizer | undefined);
  if (summarizer) return summarizer(call.input ?? {}, active, output);
  return { verb: call.name, subject: argsPreview(call.args ?? partialArgs(call.argsText)), mono: false };
}

/**
 * A shell command's leading `cd <dir> &&` / `cd <dir>;` / `pushd <dir> &&`, split off for the
 * one-line summary (I-152): agents start fresh shells in the chat's folder and often `cd` first,
 * which hides the actual command. `dir` is null when the `cd` goes to the chat's own folder (then
 * it's dropped); otherwise a short label: relative to the chat's folder, else `~`-shortened.
 * Only the display changes; the expanded view shows the exact command.
 */
export function splitLeadingCd(command: string, cwd?: string | null, home?: string | null): { dir: string | null; rest: string } | null {
  const m = /^\s*(?:cd|pushd)\s+("([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;)\s*/.exec(command);
  if (!m) return null;
  const rest = command.slice(m[0].length);
  if (!rest.trim()) return null;
  let target = (m[2] ?? m[3] ?? m[4] ?? "").replace(/\/+$/, "");
  const homeDir = home?.replace(/\/+$/, "");
  if (homeDir && (target === "~" || target.startsWith("~/"))) target = homeDir + target.slice(1);
  else if (homeDir && target.startsWith("$HOME")) target = homeDir + target.slice(5);
  const base = cwd?.replace(/\/+$/, "");
  if (base && !target.startsWith("/")) target = target === "." ? base : `${base}/${target.replace(/^\.\//, "")}`;
  if (base && target === base) return { dir: null, rest };
  if (base && target.startsWith(`${base}/`)) return { dir: target.slice(base.length + 1), rest };
  if (homeDir && (target === homeDir || target.startsWith(`${homeDir}/`))) return { dir: `~${target.slice(homeDir.length)}`, rest };
  return { dir: target || null, rest };
}

/** Header for a collapsed group of calls. */
export function groupLabel(count: number, active: boolean): string {
  const noun = count === 1 ? "tool call" : "tool calls";
  return active ? `Running ${count} ${noun}…` : `Ran ${count} ${noun}`;
}
