/**
 * Answering a permission card by voice (I-180): what the agent asks, said aloud, and which of the
 * server's options a spoken answer means. The options are the agent's own (Claude Code: "Yes" /
 * "Yes, and don't ask again for …" / "No, and tell Claude what to do differently"; Codex: "Yes,
 * proceed" / "Yes, for this session" / …; ACP: allow/reject once/always), so answers match by
 * option kind first ("yes" → allow once, "yes always" → allow always, "no" → the rejection that
 * hands back to the user), then by the label's words ("don't ask again", "for this session"), then
 * by position ("the second one").
 */
import type { PermissionOption, UiRequest } from "@glade/protocol";

export type PermissionRequest = UiRequest & { kind: "permission" };

/** Words the recognizer should expect while waiting for an answer. */
export const ANSWER_WORDS = ["yes", "yes always", "always", "no", "don't ask again", "allow", "deny"];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NEGATIVE = /^(no|nope|nah|dont|do not|deny|reject|refuse|cancel|stop|never ?mind|not now|negative|wait)\b/;
const NEGATIVE_ANYWHERE = /\b(no|nope|deny|reject|dont do|do not)\b/;
const AFFIRMATIVE = /\b(yes|yeah|yep|yup|ya|sure|ok|okay|allow|approve|go ahead|go for it|do it|proceed|fine|affirmative|please do|of course|sounds good|alright|all right)\b/;
const ALWAYS = /\b(always|dont ask( me)? again|never ask|every time|for (the|this) session|for good|from now on|remember)\b/;
const ORDINALS: Record<string, number> = { one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4, five: 5, fifth: 5 };

/** The option a spoken answer picks, or null when it's unclear. */
export function matchPermissionAnswer(utterance: string, options: readonly PermissionOption[]): PermissionOption | null {
  const said = normalize(utterance);
  if (!said || options.length === 0) return null;

  // "option two", "the second one", "number 2", or just "2".
  const pick = /^(?:(?:option|number|choice)\s+)?(?:the\s+)?(\d|one|two|three|four|five|first|second|third|fourth|fifth)(?:\s+one)?(?:\s+please)?$/.exec(said);
  if (pick) {
    const n = /\d/.test(pick[1]!) ? Number(pick[1]) : ORDINALS[pick[1]!]!;
    return options[n - 1] ?? null;
  }

  // The label itself (or its start): "yes and dont ask again for npm", "yes for this session".
  for (const o of options) {
    const label = normalize(o.label);
    if (said === label || (said.split(" ").length >= 3 && label.startsWith(said))) return o;
  }

  const allowOnce = options.find((o) => o.kind === "allow_once");
  const allowAlways = options.find((o) => o.kind === "allow_always");
  const reject = options.find((o) => o.focusComposer) ?? options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind === "reject_always");

  const negative = NEGATIVE.test(said) || (NEGATIVE_ANYWHERE.test(said) && !AFFIRMATIVE.test(said));
  // "Don't ask again" is a yes; "no, never" isn't.
  const always = ALWAYS.test(said) && !/^(no|nope|nah)\b/.test(said);
  if (always) {
    if (allowAlways) return allowAlways;
    // Codex offers "for this turn" / "for this session": the session one is the always.
    const byLabel = options.find((o) => o.kind.startsWith("allow") && ALWAYS.test(normalize(o.label)));
    return byLabel ?? null;
  }
  if (negative) return reject ?? null;
  if (AFFIRMATIVE.test(said)) return allowOnce ?? allowAlways ?? null;
  return null;
}

/** The option to pick for "no": the one that stops and asks the user what to do instead, if any. */
export function rejectOption(options: readonly PermissionOption[]): PermissionOption | null {
  return options.find((o) => o.focusComposer) ?? options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind === "reject_always") ?? null;
}

/**
 * The question said aloud: "<agent> wants to <summary>. Allow?". Titles already phrased that way
 * ("Claude wants to read foo.ts") are read as they are; "Allow Bash?" with a command becomes
 * "Claude Code wants to use Bash: npm test. Allow?".
 */
export function permissionQuestion(request: PermissionRequest, agent: string | null): string {
  const who = agent?.trim() || "The agent";
  const title = speakPlain(request.title).replace(/[?.!:\s]+$/, "");
  const detail = request.message ? speakPlain(firstLine(request.message)) : "";
  let ask: string;
  if (/\bwants to\b/i.test(title)) ask = title;
  else {
    const allow = /^allow\s+(.+)$/i.exec(title);
    const what = allow ? `use ${allow[1]}` : `know: ${title}`;
    ask = `${who} wants to ${what}${detail ? `: ${detail}` : ""}`;
  }
  return `${ask}. Allow?`;
}

/** Asked again after an unclear answer. */
export function permissionRetryQuestion(options: readonly PermissionOption[]): string {
  const always = options.some((o) => o.kind === "allow_always");
  return `Sorry, I didn't catch that. Say yes${always ? ", yes always," : ""} or no.`;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/** Drops markdown-ish symbols from a short one-line text. */
function speakPlain(text: string): string {
  return text.replace(/[`*_#|<>]/g, "").replace(/\s+/g, " ").trim();
}
