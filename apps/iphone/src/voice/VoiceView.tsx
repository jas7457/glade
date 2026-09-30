/**
 * Conversation mode's full-screen view (I-180), over the chat like ChatGPT's voice mode: a large
 * animated orb for listening / thinking / speaking, what you're saying (live), the reply growing as
 * it streams and is read (I-183) with the current word highlighted, and the controls: mute the mic,
 * stop speaking, close (back to the chat, where everything is in the transcript). A permission question shows its
 * answers as big buttons too. When speech isn't possible, a sheet says how to allow it.
 *
 * With the fake engine (browser / simulator until the native one lands) a small "Say…" field
 * stands in for the microphone.
 */
import { ChevronDown, Mic, MicOff, Square, X } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { PermissionOption } from "@glade/protocol";
import { cn } from "@glade/app-core/lib/cn";
import { PhoneButton, Sheet } from "~/ui/phone";
import type { Conversation } from "./conversation";
import type { VoiceEngine } from "./engine";
import { isFakeVoiceEngine } from "./fake-engine";
import { followScrollTop } from "./follow-scroll";
import type { Phase, VoiceState } from "./machine";
import type { ReplyPiece } from "./reply-stream";
import type { Speakable } from "./speakable";

export interface VoiceViewProps {
  conversation: Conversation;
  engine: VoiceEngine;
  title?: string;
  onClose: () => void;
}

type Look = "listening" | "thinking" | "speaking" | "muted" | "error" | "idle";

function lookOf(state: VoiceState): Look {
  const p = state.phase;
  if (p.name === "error") return "error";
  if (p.name === "speaking" || (p.name === "asking" && p.speech)) return "speaking";
  if (p.name === "working" || p.name === "sending") return "thinking";
  if (p.name === "starting" || p.name === "unavailable") return "idle";
  return state.muted ? "muted" : "listening";
}

function statusText(state: VoiceState): string {
  const p = state.phase;
  switch (p.name) {
    case "starting":
      return "Starting…";
    case "unavailable":
      return "Voice isn't available";
    case "listening":
      return state.muted ? "Muted" : "Listening";
    case "sending":
      return "Sending…";
    case "working":
      return "Working…";
    case "speaking":
      return "Speaking";
    case "asking":
      return p.step === "instead" ? (p.speech ? "Asking" : "What should it do instead?") : "Permission needed";
    case "error":
      return "Something went wrong";
    case "closed":
      return "";
  }
}

export function VoiceView({ conversation, engine, title, onClose }: VoiceViewProps) {
  const state = conversation.state.value;
  const chat = conversation.chat.value;
  const p = state.phase;
  const look = lookOf(state);
  const speech = p.name === "asking" ? p.speech : null;
  const word = p.name === "asking" ? p.word : null;
  const speakingNow = look === "speaking";
  const question = p.name === "asking" && p.step !== "instead" ? p.request : null;
  // The latest reply: growing while it streams, read as it grows, readable after it was read,
  // until the user says something new.
  const reading = state.reading;
  const shownReply =
    reading?.shown && (reading.speech.text || reading.tail) && (p.name === "speaking" || p.name === "working" || p.name === "listening") ? reading : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Voice mode"
      data-look={look}
      class="fixed inset-0 z-40 flex flex-col bg-window text-fg animate-[phone-fade_160ms_ease-out]"
    >
      <header class="flex shrink-0 items-center justify-between px-2 pt-[env(safe-area-inset-top)]">
        <button type="button" aria-label="Back to chat" onClick={onClose} class="flex size-11 items-center justify-center rounded-full text-accent active:opacity-50">
          <ChevronDown size={26} />
        </button>
        <div class="min-w-0 flex-1 truncate text-center text-[17px] font-semibold text-fg-strong">{title ?? "Voice"}</div>
        <div class="size-11" />
      </header>

      <div class="flex min-h-0 flex-1 flex-col items-center px-6">
        <div class="flex shrink-0 flex-col items-center pt-6 pb-4">
          <Orb look={look} />
          <div role="status" class="mt-5 text-[15px] font-medium text-fg-muted">
            {statusText(state)}
          </div>
          {state.notice && <div class="mt-1 text-[13px] text-fg-subtle">{state.notice}</div>}
        </div>

        <div class="min-h-0 w-full flex-1 overflow-y-auto overscroll-contain text-center" data-testid="voice-content" data-voice-scroll>
          {state.partial ? (
            <p class="text-[22px] leading-snug font-medium text-fg-strong" data-testid="voice-partial">
              {state.partial}
            </p>
          ) : p.name === "sending" ? (
            <p class="text-[20px] leading-snug text-fg-muted">{p.text}</p>
          ) : null}

          {p.name === "asking" && speech && <SpokenText speech={speech} word={word} class="text-[22px] font-medium" />}
          {question && !speech && <p class="text-[20px] leading-snug text-fg-strong">{question.title}</p>}
          {question && question.message && <p class="mt-2 font-mono text-[14px] break-words whitespace-pre-wrap text-fg-muted">{question.message}</p>}
          {question && <AnswerButtons options={question.options} onAnswer={(id) => conversation.dispatch({ type: "answer", optionId: id })} />}

          {!state.partial && shownReply && (
            <SpokenText speech={shownReply.speech} tail={shownReply.tail} word={p.name === "speaking" ? shownReply.word : null} class="text-left text-[19px]" />
          )}

          {p.name === "error" && (
            <div class="flex flex-col items-center gap-3">
              <p role="alert" class="text-[17px] text-danger">
                {p.message}
              </p>
              <PhoneButton kind="tinted" block={false} onClick={() => conversation.dispatch({ type: "retry" })}>
                Try Again
              </PhoneButton>
            </div>
          )}

          {chat?.otherRequest && !question && (
            <div class="mt-4 flex flex-col items-center gap-2">
              <p class="text-[15px] text-fg-muted">The agent is asking something on screen.</p>
              <PhoneButton kind="tinted" block={false} onClick={onClose}>
                Show Chat
              </PhoneButton>
            </div>
          )}
        </div>
      </div>

      {isFakeVoiceEngine(engine) && <DebugSay onSay={(text) => void engine.hear(text)} />}

      <footer class="flex shrink-0 items-center justify-center gap-8 px-6 pt-3 pb-[max(calc(env(safe-area-inset-bottom)_+_8px),20px)]">
        <RoundButton label={state.muted ? "Unmute microphone" : "Mute microphone"} pressed={state.muted} onClick={() => conversation.dispatch({ type: "mute", muted: !state.muted })}>
          {state.muted ? <MicOff size={26} /> : <Mic size={26} />}
        </RoundButton>
        <RoundButton label="Stop speaking" disabled={!speakingNow} onClick={() => conversation.dispatch({ type: "stop-speaking" })}>
          <Square size={22} fill="currentColor" strokeWidth={0} />
        </RoundButton>
        <RoundButton label="Close voice mode" tone="danger" onClick={onClose}>
          <X size={28} />
        </RoundButton>
      </footer>

      <UnavailableSheet phase={p} onRetry={() => conversation.dispatch({ type: "retry" })} onClose={onClose} />
    </div>
  );
}

/** The big animated circle. */
function Orb({ look }: { look: Look }) {
  return (
    <div class="relative flex size-40 items-center justify-center" aria-hidden data-testid="voice-orb">
      <div
        class={cn(
          "absolute inset-0 rounded-full bg-accent/15",
          look === "listening" && "animate-[voice-pulse_1.8s_ease-in-out_infinite]",
          look === "speaking" && "animate-[voice-pulse_0.9s_ease-in-out_infinite]",
        )}
      />
      <div
        class={cn(
          "relative size-28 rounded-full transition-colors duration-300",
          look === "error" ? "bg-danger" : look === "muted" || look === "idle" ? "bg-fg-subtle/50" : "bg-accent",
          look === "thinking" && "animate-[voice-breathe_2.4s_ease-in-out_infinite]",
        )}
      >
        {look === "speaking" && (
          <div class="absolute inset-0 flex items-center justify-center gap-1.5">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} class="w-1.5 rounded-full bg-accent-fg animate-[voice-bar_0.8s_ease-in-out_infinite]" style={{ height: "40%", animationDelay: `${i * 0.12}s` }} />
            ))}
          </div>
        )}
        {look === "thinking" && <div class="absolute inset-3 rounded-full border-4 border-accent-fg/40 border-t-accent-fg animate-spin [animation-duration:1.4s]" />}
      </div>
    </div>
  );
}

/**
 * Spoken text with the current word highlighted; announcements in muted italics. The highlight is
 * a background only (no padding or weight change), so moving it never reflows the lines. `tail`:
 * text still being written (not final, so not read yet), shown dimmed after it.
 */
export function SpokenText({ speech, tail, word, class: className }: { speech: Speakable; tail?: ReplyPiece | null; word: [number, number] | null; class?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  // Keep the word being read in view: scroll only when it leaves the comfortable band, not on
  // every word (follow-scroll.ts).
  useEffect(() => {
    const el = ref.current?.querySelector("[data-current]");
    const view = el?.closest<HTMLElement>("[data-voice-scroll]");
    if (!el || !view) return;
    const v = view.getBoundingClientRect();
    const w = el.getBoundingClientRect();
    const top = followScrollTop(view, { top: w.top - v.top, bottom: w.bottom - v.top });
    if (top !== null) view.scrollTo?.({ top, behavior: "smooth" });
  }, [word?.[0]]);
  const parts: Array<{ text: string; note: boolean; current: boolean; key: number }> = [];
  // Cut the text where announcements start/end and around the current word.
  const cuts = new Set<number>([0, speech.text.length]);
  for (const s of speech.segments) if (s.note) cuts.add(s.start).add(s.end);
  if (word) cuts.add(word[0]).add(word[1]);
  const points = [...cuts].filter((n) => n >= 0 && n <= speech.text.length).sort((a, b) => a - b);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const z = points[i + 1]!;
    const note = speech.segments.some((s) => s.note && s.start <= a && s.end >= z);
    parts.push({ text: speech.text.slice(a, z), note, current: !!word && a >= word[0] && z <= word[1], key: a });
  }
  return (
    <p ref={ref} class={cn("leading-relaxed break-words whitespace-pre-wrap text-fg-strong", className)} data-testid="voice-spoken">
      {parts.map((part) => (
        <span key={part.key} class={cn(part.note && "text-fg-muted italic", part.current && "rounded-[4px] bg-accent/25 text-fg-strong")} data-current={part.current || undefined}>
          {part.text}
        </span>
      ))}
      {tail && (
        <span class="text-fg-muted" data-testid="voice-tail">
          {speech.text ? tail.sep : ""}
          {tail.speech.text}
        </span>
      )}
    </p>
  );
}

/** The permission's options as big buttons (allow first). */
function AnswerButtons({ options, onAnswer }: { options: PermissionOption[]; onAnswer: (id: string) => void }) {
  return (
    <div class="mt-5 flex w-full flex-col gap-2.5" aria-label="Answers">
      {options.map((o) => (
        <PhoneButton key={o.id} kind={o.kind === "allow_once" ? "filled" : "tinted"} class={cn("min-h-13 text-left", o.kind.startsWith("reject") && "text-danger")} onClick={() => onAnswer(o.id)}>
          {o.label}
        </PhoneButton>
      ))}
    </div>
  );
}

function RoundButton({
  label,
  children,
  onClick,
  disabled,
  pressed,
  tone,
}: {
  label: string;
  children: preact.ComponentChildren;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  tone?: "danger";
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      class={cn(
        "flex size-16 items-center justify-center rounded-full select-none active:opacity-60 disabled:opacity-30",
        tone === "danger" ? "bg-danger/15 text-danger" : pressed ? "bg-fg text-window" : "bg-fg/10 text-fg",
      )}
    >
      {children}
    </button>
  );
}

/** Fake engine only: type what you'd say. */
function DebugSay({ onSay }: { onSay: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      class="mx-6 mb-1 flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onSay(text.trim());
        setText("");
        // Put the keyboard away so the view (and its controls) show.
        (e.currentTarget as HTMLFormElement).querySelector("input")?.blur();
      }}
    >
      <input
        aria-label="Say (debug)"
        placeholder="Say… (fake microphone)"
        value={text}
        onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
        class="h-9 min-w-0 flex-1 rounded-lg border border-dashed border-separator bg-transparent px-3 text-[16px] text-fg outline-none placeholder:text-fg-subtle"
      />
      <button type="submit" class="px-2 text-[15px] text-accent">
        Say
      </button>
    </form>
  );
}

/** Speech isn't allowed or isn't available: how to fix it. */
function UnavailableSheet({ phase, onRetry, onClose }: { phase: Phase; onRetry: () => void; onClose: () => void }) {
  const open = phase.name === "unavailable";
  const denied = open && phase.reason === "denied";
  return (
    <Sheet open={open} onClose={onClose} title={denied ? "Allow Voice" : "Voice Unavailable"}>
      <div class="px-5 pt-2 pb-4 text-[15px] leading-relaxed text-fg">
        {denied ? (
          <>
            <p>Voice mode needs the microphone and speech recognition to hear you. Speech is recognized on this iPhone; nothing is sent anywhere else.</p>
            <p class="mt-3 text-fg-muted">
              Open <b>Settings → Apps → Glade</b> and turn on <b>Microphone</b> and <b>Speech Recognition</b>, then come back and try again.
            </p>
          </>
        ) : (
          <>
            <p>On-device speech recognition isn't available right now.</p>
            <p class="mt-3 text-fg-muted">
              Check that <b>Siri &amp; Dictation</b> is set up for your language in <b>Settings → General → Keyboard → Enable Dictation</b>, and that your language is supported.
            </p>
          </>
        )}
        <div class="mt-5 flex flex-col gap-2">
          <PhoneButton onClick={onRetry}>Try Again</PhoneButton>
          <PhoneButton kind="plain" block onClick={onClose}>
            Back to Chat
          </PhoneButton>
        </div>
      </div>
    </Sheet>
  );
}
