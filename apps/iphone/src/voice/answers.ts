/**
 * Answering a permission card by voice (I-180): what the agent asks, said aloud, and which of the
 * server's options a spoken answer means. The options are the agent's own (Claude Code: "Yes" /
 * "Yes, and don't ask again for …" / "No, and tell Claude what to do differently"; Codex: "Yes,
 * proceed" / "Yes, for this session" / …; ACP: allow/reject once/always), so answers match by
 * option kind first ("yes" → allow once, "yes always" → allow always, "no" → the rejection that
 * hands back to the user), then by the label's words ("don't ask again", "for this session"), then
 * by position ("the second one").
 *
 * The agent's other questions (I-193) are spoken and answered the same way: a `select` by an
 * option's name (fuzzy) or number, a `confirm` by yes / no, an `input` with what the user says.
 * (`editor` requests, a text to edit, stay on screen.)
 */
import type { PermissionOption, UiRequest, UiResponse } from "@glade/protocol";

export type PermissionRequest = UiRequest & { kind: "permission" };
export type SelectRequest = UiRequest & { kind: "select" };
export type ConfirmRequest = UiRequest & { kind: "confirm" };
export type InputRequest = UiRequest & { kind: "input" };
/** A question voice mode reads aloud and takes a spoken answer for. */
export type VoiceQuestion = PermissionRequest | SelectRequest | ConfirmRequest | InputRequest;

export function isVoiceQuestion(request: UiRequest): request is VoiceQuestion {
  return request.kind === "permission" || request.kind === "confirm" || request.kind === "input" || (request.kind === "select" && request.options.length > 0);
}

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
const ORDINALS: Record<string, number> = {
  one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4, five: 5, fifth: 5,
  six: 6, sixth: 6, seven: 7, seventh: 7, eight: 8, eighth: 8, nine: 9, ninth: 9, ten: 10, tenth: 10,
};
const ORDINAL_WORDS = Object.keys(ORDINALS).join("|");
/** "option two", "the second one", "number 2", "2", "the last one". */
const PICK = new RegExp(`^(?:(?:option|number|choice)\\s+)?(?:the\\s+)?(\\d{1,2}|${ORDINAL_WORDS}|last)(?:\\s+(?:one|option))?(?:\\s+please)?$`);

/** The 1-based position a spoken "the second one" means (`last` → `count`), or null. */
function spokenPosition(said: string, count: number): number | null {
  const pick = PICK.exec(said);
  if (!pick) return null;
  const word = pick[1]!;
  return word === "last" ? count : /\d/.test(word) ? Number(word) : ORDINALS[word]!;
}

/** The option a spoken answer picks, or null when it's unclear. */
export function matchPermissionAnswer(utterance: string, options: readonly PermissionOption[]): PermissionOption | null {
  const said = normalize(utterance);
  if (!said || options.length === 0) return null;

  // "option two", "the second one", "number 2", or just "2".
  const n = spokenPosition(said, options.length);
  if (n !== null) return options[n - 1] ?? null;

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

// ---------------------------------------------------------------------------------------------
// Other questions (I-193)
// ---------------------------------------------------------------------------------------------

/** Filler around a spoken choice: "let's go with postgres please" → "postgres". */
const FILLER = /^(?:(?:um+|uh+|well|so|ok(?:ay)?|hmm+|i think|i(?: would|d)? (?:like|want|pick|choose|say)|i(?: will|ll) (?:take|go with|have)|lets? (?:go with|do|use|pick)|go with|use|pick|choose|take|maybe|probably|the one (?:with|that says|called)|it'?s)\s+)+/;

/** Words of a label for fuzzy matching (normalized, without "the", "a" …). */
function words(text: string): string[] {
  return normalize(text)
    .split(" ")
    .filter((w) => w && !/^(the|a|an|and|or|of|to|with|for|please|one|option)$/.test(w));
}

/** Edit distance (small strings). */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** Two words are the same when they're equal or one typo apart (recognizers misspell names). */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  return distance(a, b) <= (Math.max(a.length, b.length) >= 8 ? 2 : 1);
}

/**
 * Which of a select's options a spoken answer picks (its index), or null when it's unclear: by
 * position ("the second one", "number 3", "the last one"), by the label ("Postgres"), by the
 * label's start or the words it shares with the answer (best clear match; a tie is unclear).
 */
export function matchSelectAnswer(utterance: string, options: readonly string[]): number | null {
  const said = normalize(utterance);
  if (!said || options.length === 0) return null;
  const n = spokenPosition(said, options.length);
  if (n !== null) return n >= 1 && n <= options.length ? n - 1 : null;
  const core = (said.replace(FILLER, "").trim() || said).replace(/\bsequel\b/g, "sql");
  const labels = options.map((o) => normalize(o));
  const exact = labels.findIndex((l) => l === said || l === core);
  if (exact >= 0) return exact;
  // Names split or joined differently by the recognizer ("postgres sql", "my sequel"…): compare
  // without spaces, allowing a typo or two, or as the start of the label.
  const compact = core.replace(/ /g, "");
  const squashed = labels.map((l) => l.replace(/ /g, ""));
  const close = squashed.flatMap((l, i) =>
    compact.length >= 4 && (l === compact || l.startsWith(compact) || distance(l, compact) <= Math.floor(l.length / 6)) ? [i] : [],
  );
  if (close.length === 1) return close[0]!;
  const spoken = words(core);
  if (spoken.length === 0) return null;
  // Score each option: how many of its words were said (and how much of what was said is it).
  const scores = labels.map((label) => {
    const own = words(label);
    if (own.length === 0) return 0;
    const hit = own.filter((w) => spoken.some((s) => sameWord(s, w))).length;
    if (hit === 0) return 0;
    const used = spoken.filter((s) => own.some((w) => sameWord(s, w))).length;
    return hit / own.length + used / spoken.length;
  });
  const best = Math.max(...scores);
  if (best < 0.5) return null;
  const top = scores.flatMap((s, i) => (s === best ? [i] : []));
  return top.length === 1 ? top[0]! : null;
}

/** A confirm's answer: true (yes), false (no), or null when it's unclear. */
export function matchConfirmAnswer(utterance: string): boolean | null {
  const said = normalize(utterance);
  if (!said) return null;
  if (NEGATIVE.test(said) || (NEGATIVE_ANYWHERE.test(said) && !AFFIRMATIVE.test(said))) return false;
  if (AFFIRMATIVE.test(said)) return true;
  return null;
}

/** The response a spoken answer gives to `question`, or null when it's unclear. */
export function matchAnswer(question: VoiceQuestion, utterance: string): UiResponse | null {
  switch (question.kind) {
    case "permission": {
      const option = matchPermissionAnswer(utterance, question.options);
      return option ? { id: question.id, value: option.id } : null;
    }
    case "select": {
      const i = matchSelectAnswer(utterance, question.options);
      return i === null ? null : { id: question.id, value: question.options[i]! };
    }
    case "confirm": {
      const yes = matchConfirmAnswer(utterance);
      return yes === null ? null : { id: question.id, confirmed: yes };
    }
    case "input": {
      const text = utterance.trim();
      return text ? { id: question.id, value: text } : null;
    }
  }
}

/** "A, B or C". */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

/** Short lists are read by name ("A, B or C."), long ones by number ("1: A. 2: B. …"). */
function optionsSpoken(options: readonly string[]): string {
  const plain = options.map((o) => speakPlain(o).replace(/[.?!:;,]+$/, ""));
  if (plain.length <= 4) return `The options are ${listed(plain)}.`;
  return `The options are: ${plain.map((o, i) => `${i + 1}: ${o}.`).join(" ")}`;
}

/** The question said aloud (permission cards: `permissionQuestion`). */
export function questionText(question: VoiceQuestion, agent: string | null): string {
  if (question.kind === "permission") return permissionQuestion(question, agent);
  const title = speakPlain(question.title).replace(/\s*[:.]$/, "");
  const ask = /[?]$/.test(title) ? title : `${title}.`;
  switch (question.kind) {
    case "select":
      return `${ask} ${optionsSpoken(question.options)}`;
    case "confirm": {
      const detail = question.message ? ` ${speakPlain(firstLine(question.message)).replace(/[.?!]?$/, ".")}` : "";
      return `${ask}${detail} Yes or no?`;
    }
    case "input":
      return ask;
  }
}

/** Asked again after an unclear answer. */
export function retryText(question: VoiceQuestion): string {
  switch (question.kind) {
    case "permission":
      return permissionRetryQuestion(question.options);
    case "select":
      return `Sorry, I didn't catch that. Say the name or the number of an option.`;
    case "confirm":
      return "Sorry, I didn't catch that. Say yes or no.";
    case "input":
      return `Sorry, I didn't catch that. ${speakPlain(question.title)}`;
  }
}

/** The status line while it's asked. */
export function questionLabel(question: VoiceQuestion): string {
  return question.kind === "permission" ? "Permission needed" : "The agent asks";
}
