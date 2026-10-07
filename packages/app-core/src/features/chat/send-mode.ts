/**
 * What Send (and ↩) does right now (I-200): one pure function from the composer's state and the
 * held modifiers to a mode, so the Send button's icon, colour, label and tooltip, the ↩ keys and a
 * click with a modifier held all agree.
 *
 * | State                                   | ↩ / click        | ⌘ (or Ctrl) held | ⌥ held                      |
 * | --------------------------------------- | ---------------- | ---------------- | --------------------------- |
 * | idle                                    | Send             | Send             | Send                        |
 * | running, harness steers                 | Steer            | Follow-up        | Ask Aside¹ (else Steer)     |
 * | running, no steering                    | Queue message    | Queue message    | Ask Aside¹ (else Queue)     |
 * | shell input (`!cmd` / `!!cmd`)          | Run command      | Run command      | Run command                 |
 * | `/btw …` typed                          | Ask Aside        | Ask Aside        | Ask Aside                   |
 * | a Glade built-in typed (`/compact` …)   | Run /compact     | Run /compact     | Run /compact                |
 * | a saved prompt typed in full (`/name`)  | Insert prompt    | Insert prompt    | Insert prompt               |
 *
 * ¹ Only for harnesses with side questions, and only with text typed (attachments alone: Ask Aside,
 * disabled). ⌥ wins when both are held. A harness command (`/skill:…`) is sent like text. With
 * nothing to send the mode still shows, disabled.
 *
 * Right-clicking Send (desktop) lists the modes ↩, ⌘↩ and ⌥↩ give right now (`sendMenuModes`).
 */
/** What the user asked for while running (↩ steer, ⌘↩ follow-up, I-153); ignored when idle. */
export type SendBehavior = "steer" | "followUp";

export type SendMode = "send" | "steer" | "followUp" | "queue" | "askAside" | "runCommand" | "runBuiltin" | "insertPrompt";

/** A typed slash command that ↩ runs here instead of sending it to the agent. */
export type SendModeCommand = { kind: "btw" } | { kind: "builtin"; name: string } | { kind: "savedPrompt"; name: string };

export interface SendModeInput {
  running: boolean;
  /** The harness can steer a running agent (I-065). */
  steering: boolean;
  /** The harness can answer side questions (I-140). */
  sideQuestions: boolean;
  /** The text is a shell command (`!cmd`, I-076). */
  shellInput: boolean;
  /** There's text to send (trimmed; for shell input: the command). */
  hasText: boolean;
  hasAttachments: boolean;
  command?: SendModeCommand | null;
  /** ⌘ (or Ctrl) held. */
  meta: boolean;
  /** ⌥ held. */
  alt: boolean;
}

export interface SendModeInfo {
  mode: SendMode;
  /** There's something this mode can send. */
  enabled: boolean;
  /** For `onSend`: follow-up only in its mode; everything else steers (ignored when idle). */
  behavior: SendBehavior;
  /** The button's accessible name. */
  label: string;
  /** Its name in Send's right-click menu (title case). */
  menuLabel: string;
  tooltip: string;
}

export function sendModeFor(input: SendModeInput): SendModeInfo {
  const { running, steering, sideQuestions, shellInput, hasText, hasAttachments, command, meta, alt } = input;
  const anything = hasText || hasAttachments;
  if (shellInput) return info("runCommand", hasText);
  if (command?.kind === "btw") return info("askAside", hasText);
  if (command?.kind === "builtin") {
    const run = `Run /${command.name}`;
    return { ...info("runBuiltin", true), label: run, menuLabel: run, tooltip: `${run} (↩)` };
  }
  if (command?.kind === "savedPrompt") return { ...info("insertPrompt", true), tooltip: `Insert the saved prompt /${command.name} (↩)` };
  if (!running) return info("send", anything);
  if (alt && sideQuestions) return info("askAside", hasText);
  if (!steering) {
    const queue = info("queue", anything);
    return sideQuestions ? { ...queue, tooltip: `${queue.tooltip} · hold ⌥ to ask aside` } : queue;
  }
  if (meta) return info("followUp", anything);
  const steer = info("steer", anything);
  return { ...steer, tooltip: `${steer.tooltip}${sideQuestions ? ", ⌥ to ask aside" : ""}` };
}

const TEXT: Record<SendMode, { label: string; menuLabel: string; tooltip: string }> = {
  send: { label: "Send", menuLabel: "Send", tooltip: "Send (↩)" },
  steer: { label: "Steer", menuLabel: "Steer", tooltip: "Steer (↩): delivered after the current step · hold ⌘ for a follow-up" },
  followUp: { label: "Send follow-up", menuLabel: "Send as Follow-up", tooltip: "Follow-up (⌘↩): sent after the agent finishes" },
  queue: { label: "Queue message", menuLabel: "Queue Message", tooltip: "Queue message (↩): sent after the agent finishes" },
  askAside: { label: "Ask Aside", menuLabel: "Ask Aside", tooltip: "Ask Aside (⌥↩): answered now, the agent won't see it" },
  runCommand: { label: "Run command", menuLabel: "Run Command", tooltip: "Run command (↩)" },
  runBuiltin: { label: "Run command", menuLabel: "Run Command", tooltip: "Run command (↩)" },
  insertPrompt: { label: "Insert prompt", menuLabel: "Insert Prompt", tooltip: "Insert the saved prompt (↩)" },
};

export interface SendMenuMode extends SendModeInfo {
  /** The key that sends this way: ↩, ⌘↩ or ⌥↩. */
  shortcut: string;
  /** The modifiers that pick it (pass to the composer's send). */
  mods: { meta: boolean; alt: boolean };
}

const MENU_KEYS = [
  { shortcut: "↩", mods: { meta: false, alt: false } },
  { shortcut: "⌘↩", mods: { meta: true, alt: false } },
  { shortcut: "⌥↩", mods: { meta: false, alt: true } },
];

/**
 * The modes ↩, ⌘↩ and ⌥↩ give right now, each once (with the first key that gives it), for Send's
 * right-click menu. Idle: just Send; running: Steer / Send as Follow-up / Ask Aside (Queue Message
 * without steering). A mode is disabled when it has nothing to send, like the button.
 */
export function sendMenuModes(input: Omit<SendModeInput, "meta" | "alt">): SendMenuMode[] {
  const modes: SendMenuMode[] = [];
  for (const { shortcut, mods } of MENU_KEYS) {
    const mode = sendModeFor({ ...input, ...mods });
    if (!modes.some((m) => m.mode === mode.mode)) modes.push({ ...mode, shortcut, mods });
  }
  return modes;
}

function info(mode: SendMode, enabled: boolean): SendModeInfo {
  return { mode, enabled, behavior: mode === "followUp" ? "followUp" : "steer", ...TEXT[mode] };
}
