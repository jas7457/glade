/**
 * One-line summaries for tool calls ("Ran `ls -la`", "Read src/app.ts"...). Pure; keyed by the
 * canonical tool kind and reading only the normalized input (I-068). `other` tools fall back to
 * the harness's tool name + a preview of the raw args.
 *
 * Three tenses: `past` for a call that ran ("Ran"), `present` while it runs ("Running"), `base`
 * for one that didn't succeed (I-190: "Run `npm test`" next to "Rejected" / "Stopped" / "Failed").
 */
import type { ToolCallBlock, ToolInput, ToolKind } from "@glade/protocol";
import { displayPath, resolvePath } from "@glade/app-core/lib/paths";

export interface ToolSummary {
  /** Leading verb, e.g. "Ran" / "Running". */
  verb: string;
  /** What the verb applies to (command, path, pattern...). May be empty. */
  subject: string;
  /** Render the subject in monospace (commands, patterns, paths). */
  mono: boolean;
  /** Tooltip for the subject: the full path when the subject shows a shortened one (I-158). */
  title?: string;
}

/** The chat's folder and home, for showing tool paths relative to the chat (I-158). */
export interface PathContext {
  cwd?: string | null;
  home?: string | null;
}

type Args = Record<string, unknown>;
/** `past`: it ran; `present`: running; `base`: it was rejected, stopped or failed (I-190). */
export type Tense = "past" | "present" | "base";
/** `output` is the call's result text once it has one (only the chat tools read it). */
type Summarizer = (input: ToolInput, tense: Tense, output?: string, paths?: PathContext) => ToolSummary;

const MAX_SUBJECT = 120;

export function truncate(text: string, max = MAX_SUBJECT): string {
  const oneLine = text.replace(/\s*\n\s*/g, " ⏎ ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

const verb = (tense: Tense, past: string, present: string, base: string) => (tense === "present" ? present : tense === "base" ? base : past);

/** A path summary: shortened relative to the chat's folder, the full path as its tooltip. */
function pathSummary(verbText: string, path: string | undefined, paths: PathContext | undefined, suffix = ""): ToolSummary {
  if (!path) return { verb: verbText, subject: suffix, mono: true };
  const full = resolvePath(path, paths?.cwd, paths?.home);
  return { verb: verbText, subject: `${displayPath(path, paths?.cwd, paths?.home)}${suffix}`, mono: true, title: full };
}

/** Summaries per canonical kind; `other` has none (name + raw args preview). */
export const toolSummarizers: Record<Exclude<ToolKind, "other">, Summarizer> = {
  shell: (i, t) => ({ verb: verb(t, "Ran", "Running", "Run"), subject: truncate(i.command ?? ""), mono: true }),
  read: (i, t, _output, paths) => {
    const range = i.offset !== undefined ? `:${i.offset}${i.limit !== undefined ? `-${i.offset + i.limit - 1}` : ""}` : "";
    return pathSummary(verb(t, "Read", "Reading", "Read"), i.path, paths, range);
  },
  write: (i, t, _output, paths) => pathSummary(verb(t, "Wrote", "Writing", "Write"), i.path, paths),
  edit: (i, t, _output, paths) => pathSummary(verb(t, "Edited", "Editing", "Edit"), i.path, paths),
  search: (i, t, _output, paths) => {
    const where = i.path ? displayPath(i.path, paths?.cwd, paths?.home) : "";
    return {
      verb: verb(t, "Searched", "Searching", "Search"),
      subject: truncate(`${i.pattern ?? ""}${where ? ` in ${where}` : ""}${i.glob ? ` (${i.glob})` : ""}`),
      mono: true,
      ...(i.path ? { title: resolvePath(i.path, paths?.cwd, paths?.home) } : {}),
    };
  },
  list: (i, t, _output, paths) =>
    i.path ? pathSummary(verb(t, "Listed", "Listing", "List"), i.path, paths) : { verb: verb(t, "Listed", "Listing", "List"), subject: ".", mono: true },
  web: (i, t) =>
    i.url
      ? { verb: verb(t, "Fetched", "Fetching", "Fetch"), subject: truncate(i.url), mono: true }
      : i.query !== undefined || i.description === undefined
        ? { verb: verb(t, "Searched the web for", "Searching the web for", "Search the web for"), subject: truncate(i.query ?? ""), mono: false }
        : { verb: verb(t, "Read web results", "Reading web results", "Read web results"), subject: truncate(i.description), mono: false },
  // A spawned sub-agent reads by its name, not its (long) task (I-145); other harnesses' tasks by their description.
  task: (i, t) =>
    i.agentName
      ? { verb: verb(t, "Started agent", "Starting agent", "Start agent"), subject: i.agentName, mono: false }
      : { verb: verb(t, "Ran task", "Running task", "Run task"), subject: truncate(i.description ?? ""), mono: false },
  agent: (i, t) => {
    if (i.agentAction === "list") return { verb: verb(t, "Listed agents", "Listing agents", "List agents"), subject: "", mono: false };
    if (i.agentAction === "close") return { verb: verb(t, "Closed", "Closing", "Close"), subject: i.agentName ?? "", mono: false };
    const text = i.description ? `: ${i.description}` : "";
    return { verb: verb(t, "Messaged", "Messaging", "Message"), subject: truncate(`${i.agentName ?? ""}${text}`), mono: false };
  },
  mcp: (i, t) => {
    if (i.tool) return { verb: verb(t, "Called", "Calling", "Call"), subject: i.server ? `${i.server} › ${i.tool}` : i.tool, mono: true };
    if (i.query) return { verb: verb(t, "Searched MCP tools for", "Searching MCP tools for", "Search MCP tools for"), subject: truncate(i.query), mono: false };
    if (i.description === "script") return { verb: verb(t, "Ran MCP script", "Running MCP script", "Run MCP script"), subject: "", mono: false };
    return { verb: "MCP", subject: truncate([i.server, i.description].filter(Boolean).join(" · ")), mono: false };
  },
  chat: (i, t, output) => {
    const done = t === "past";
    if (i.chatAction === "find") {
      const query = i.query ? `"${truncate(i.query)}"` : "";
      const count = done ? foundChats(output) : undefined;
      if (count === undefined) return { verb: verb(t, "Searched chats for", "Searching chats for", "Search chats for"), subject: query, mono: false };
      return { verb: `Found ${count === 0 ? "no" : count} ${count === 1 ? "chat" : "chats"} for`, subject: query, mono: false };
    }
    const title = done ? chatTitle(output) : undefined;
    const subject = title ? `"${truncate(title)}"` : (i.chatId ?? "");
    if (i.chatAction === "open") {
      const hidden = done && !!output?.startsWith("No Glade window is open");
      return { verb: hidden ? "No window to show chat" : verb(t, "Opened chat", "Opening chat", "Open chat"), subject, mono: !title };
    }
    return { verb: verb(t, "Read chat", "Reading chat", "Read chat"), subject, mono: !title };
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
  /** `true`/`false`: running or ran; or a {@link Tense} (`base` for calls that didn't succeed). */
  active: boolean | Tense,
  /** The result's text, when the call has one (a few kinds summarize what they found). */
  output?: string,
  /** The chat's folder/home: paths inside the folder show relative to it, others `~`-shortened (I-158). */
  paths?: PathContext,
): ToolSummary {
  // Looked up defensively: a kind this build doesn't know renders like `other`.
  const summarizer = call.kind === "other" ? undefined : (toolSummarizers[call.kind] as Summarizer | undefined);
  const tense: Tense = active === true ? "present" : active === false ? "past" : active;
  if (summarizer) return summarizer(call.input ?? {}, tense, output, paths);
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

/**
 * Header for a collapsed group of calls. `ran`: how many actually ran (I-190: rejected and stopped
 * ones are counted next to it, "Ran 2 tool calls · 1 rejected"); none: just the count.
 */
export function groupLabel(count: number, active: boolean, ran = count): string {
  const noun = (n: number) => (n === 1 ? "tool call" : "tool calls");
  if (active) return `Running ${count} ${noun(count)}…`;
  return ran > 0 ? `Ran ${ran} ${noun(ran)}` : `${count} ${noun(count)}`;
}
