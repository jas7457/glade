/**
 * Scrolling transcript for one chat. Reusable anywhere: give it a `chatId`.
 *
 * Renders the items produced by `groupTranscript` (grouping.ts): user bubbles (sub-agent reports
 * as cards, AgentMessageCard.tsx), assistant turns (markdown, thinking, tool rows/groups,
 * errors) and notices. Sticks to the bottom while
 * streaming unless the user scrolls up, in which case a "Jump to latest" button appears.
 *
 * The "Working…" row at the bottom stays for the whole run (working.ts) and shows the run's
 * elapsed time; streamed reply text is revealed smoothly (smooth-text.ts).
 */
import { memo } from "preact/compat";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ArrowDown, CircleAlert, Info, OctagonX, Scissors, Terminal, TriangleAlert } from "lucide-preact";
import { parseAgentMessage, type ImageBlock, type NoticeMessage, type UserMessage } from "@glade/protocol";
import { cn } from "@/lib/cn";
import { loadChatSession, useChatSession } from "@/state/chat-session";
import { Button, Disclosure, Spinner } from "@/ui";
import { formatDuration, useNow } from "./duration";
import { DEFAULT_GROUPING_OPTIONS, groupTranscript, type GroupingOptions, type RenderItem, type TurnPart } from "./grouping";
import { AgentMessageCard } from "./AgentMessageCard";
import { Markdown } from "./Markdown";
import { ThinkingView } from "./Thinking";
import { ToolCallRow, ToolGroup } from "./tools/ToolViews";
import { useSmoothText } from "./smooth-text";
import { useStickToBottom } from "./useStickToBottom";
import { workingStatus, type WorkingLabel } from "./working";
import "./chat.css";

export interface TranscriptProps {
  chatId: string;
  /** Override tool grouping rules (defaults to DEFAULT_GROUPING_OPTIONS). */
  grouping?: GroupingOptions;
  class?: string;
  /** Classes for the centered content column (default: max-w-[760px] with padding). */
  columnClass?: string;
}

export const columnClass = "mx-auto w-full max-w-[760px] px-6";

export function Transcript({ chatId, grouping = DEFAULT_GROUPING_OPTIONS, class: className, columnClass: column = columnClass }: TranscriptProps) {
  const store = useChatSession(chatId);
  const transcript = store.transcript.value;
  const state = store.state.value;
  const status = store.status.value;
  const isRunning = state.isRunning;

  const items = useMemo(() => groupTranscript(transcript, { isRunning }, grouping), [transcript, isRunning, grouping]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { atBottom, scrollToBottom } = useStickToBottom(scrollRef, contentRef);

  // Jump to the bottom when the user sends a message, and when switching chats.
  const lastUserId = useMemo(() => {
    for (let i = transcript.messages.length - 1; i >= 0; i--) if (transcript.messages[i]!.role === "user") return transcript.messages[i]!.id;
    return null;
  }, [transcript.messages]);
  useEffect(() => scrollToBottom(), [lastUserId, chatId, status === "ready"]);

  const working = workingStatus(transcript, state);

  let placeholder = null;
  if (items.length === 0 && (status === "loading" || status === "idle")) {
    placeholder = (
      <div class="flex flex-1 items-center justify-center">
        <Spinner size={18} />
      </div>
    );
  } else if (status === "error" && items.length === 0) {
    placeholder = (
      <div class="flex flex-1 flex-col items-center justify-center gap-3 text-fg-muted">
        <div class="flex items-center gap-2">
          <CircleAlert size={16} class="text-danger" />
          <span>Couldn't open this chat{store.error.value ? `: ${store.error.value}` : ""}</span>
        </div>
        <Button size="sm" onClick={() => void loadChatSession(chatId)}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div class={cn("relative flex min-h-0 flex-1 flex-col", className)}>
      <div ref={scrollRef} class="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="transcript-scroll">
        {placeholder}
        <div ref={contentRef} class={cn(column, "flex flex-col pt-6 pb-8", placeholder && "hidden")}>
          {items.map((item) => (
            <ItemView key={item.key} item={item} />
          ))}
          {working.mounted && <WorkingIndicator key="working" visible={working.visible} label={working.label} startedAt={state.runStartedAt ?? null} />}
        </div>
      </div>
      {!atBottom && (
        <button
          type="button"
          onClick={() => scrollToBottom("smooth")}
          class="absolute bottom-3 left-1/2 flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full bg-surface-raised px-3 text-[0.92rem] text-fg-muted shadow-popover hover:text-fg"
        >
          <ArrowDown size={13} />
          Jump to latest
        </button>
      )}
    </div>
  );
}

function ItemView({ item }: { item: RenderItem }) {
  switch (item.type) {
    case "user":
      return <UserBubble message={item.message} />;
    case "notice":
      return <NoticeRow message={item.message} />;
    case "turn":
      return (
        <div class="mt-4 flex flex-col first:mt-0" data-role="assistant">
          {item.parts.map((part) => (
            <PartView key={part.key} part={part} />
          ))}
        </div>
      );
  }
}

function PartView({ part }: { part: TurnPart }) {
  switch (part.type) {
    case "text":
      return <ReplyText text={part.text} streaming={part.streaming} />;
    case "thinking":
      return <ThinkingView text={part.text} streaming={part.streaming} />;
    case "tool":
      return <ToolCallRow part={part} />;
    case "toolGroup":
      return <ToolGroup part={part} />;
    case "image":
      return <ImageThumb image={part.image} class="my-1.5 max-h-80" />;
    case "error":
      return <ErrorNotice kind={part.kind} message={part.message} details={part.details} />;
  }
}

/** Assistant reply text; revealed smoothly while it streams (I-072). */
function ReplyText({ text, streaming }: { text: string; streaming: boolean }) {
  const shown = useSmoothText(text, streaming);
  return <Markdown text={shown} streaming={streaming} class="my-1.5" />;
}

export const UserBubble = memo(function UserBubble({ message }: { message: UserMessage }) {
  const images = message.content.filter((b): b is ImageBlock => b.type === "image");
  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n\n");
  // Sub-agent reports arrive as prompts but aren't the user's words (I-075).
  const agentMessage = useMemo(() => (images.length === 0 ? parseAgentMessage(text) : null), [text, images.length]);
  if (agentMessage) return <AgentMessageCard message={agentMessage} />;
  return (
    <div class="mt-6 flex flex-col items-end gap-1.5 first:mt-0" data-role="user">
      {images.length > 0 && (
        <div class="flex flex-wrap justify-end gap-1.5">
          {images.map((img, i) => (
            <ImageThumb key={i} image={img} class="max-h-40" />
          ))}
        </div>
      )}
      {text && (
        <div class="selectable max-w-[85%] rounded-[14px] bg-selected px-3.5 py-2 leading-[1.5] whitespace-pre-wrap break-words">
          {text}
        </div>
      )}
    </div>
  );
});

function ImageThumb({ image, class: className }: { image: ImageBlock; class?: string }) {
  return (
    <img
      src={`data:${image.mimeType};base64,${image.data}`}
      alt=""
      class={cn("rounded-[10px] border-[0.5px] border-separator object-contain", className)}
    />
  );
}

export function ErrorNotice({ kind, message, details }: { kind: "error" | "aborted"; message: string; details?: string }) {
  if (kind === "aborted") {
    return (
      <div class="my-1.5 flex items-center gap-2 text-[0.92rem] text-fg-subtle">
        <OctagonX size={13} />
        <span>{message === "Stopped" ? "Stopped" : `Stopped · ${message}`}</span>
      </div>
    );
  }
  return (
    <div
      role="alert"
      class="selectable my-2 flex items-start gap-2 rounded-[8px] border-[0.5px] border-danger/30 bg-danger/10 px-3 py-2 text-[0.95rem] text-danger"
    >
      <CircleAlert size={14} class="mt-[3px] shrink-0" />
      <div class="min-w-0 flex-1">
        <div class="break-words whitespace-pre-wrap">{message}</div>
        {details && details !== message && (
          <Disclosure label="Details" defaultOpen={false} class="-ml-1 mt-0.5 text-[0.88rem]">
            <pre class="selectable mt-1 max-h-48 overflow-auto rounded-[6px] bg-code px-2 py-1.5 font-mono text-[0.85rem] leading-[1.45] whitespace-pre-wrap break-all text-fg-muted">
              {details}
            </pre>
          </Disclosure>
        )}
      </div>
    </div>
  );
}

const noticeIcons = { info: Info, warning: TriangleAlert, error: CircleAlert, compaction: Scissors, bash: Terminal } as const;

export const NoticeRow = memo(function NoticeRow({ message }: { message: NoticeMessage }) {
  const Icon = noticeIcons[message.kind];
  if (message.kind === "bash") {
    return (
      <div class="my-3 overflow-hidden rounded-[8px] border-[0.5px] border-separator bg-code" data-role="notice">
        <pre class="selectable max-h-72 overflow-auto px-3 py-2 font-mono text-[0.88rem] leading-[1.45] whitespace-pre-wrap break-words text-fg-muted">
          {message.text}
        </pre>
      </div>
    );
  }
  return (
    <div
      data-role="notice"
      class={cn(
        "my-4 flex items-center gap-3 text-[0.88rem]",
        message.kind === "error" ? "text-danger" : message.kind === "warning" ? "text-warning" : "text-fg-subtle",
      )}
    >
      <div class="h-px flex-1 bg-separator" />
      <span class="selectable flex max-w-[80%] items-center gap-1.5 text-center">
        <Icon size={12} class="shrink-0" />
        {message.text}
      </span>
      <div class="h-px flex-1 bg-separator" />
    </div>
  );
});

/** How long to keep showing the row after it's asked to hide (swallows brief flickers). */
const HIDE_DELAY_MS = 300;

/**
 * The run's status row. Mounted for the whole run so it never remounts; its slot keeps its
 * height while hidden (reply text streaming), so nothing below it jumps.
 */
export function WorkingIndicator({ visible, label, startedAt }: { visible: boolean; label: WorkingLabel; startedAt: number | null }) {
  const [shown, setShown] = useState(visible);
  useEffect(() => {
    if (visible) {
      setShown(true);
      return;
    }
    const timer = setTimeout(() => setShown(false), HIDE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [visible]);
  const now = useNow(startedAt !== null, startedAt);
  // A soft rainbow sweep (I-077); thinking gets a calmer violet/blue one.
  const thinking = label === "Thinking…";
  return (
    <div
      class={cn("mt-4 flex h-7 items-center gap-2 transition-opacity duration-150", !shown && "opacity-0")}
      aria-hidden={!shown}
      data-testid="working-indicator"
    >
      <span class={cn("flex", thinking ? "pi-thinking-color" : "pi-rainbow-color")}>
        <Spinner size={13} class="text-current" />
      </span>
      <span class={thinking ? "pi-thinking-text" : "pi-rainbow"} aria-live="polite">
        {label}
      </span>
      {startedAt !== null && <span class="text-fg-subtle tabular-nums">{formatDuration(now - startedAt)}</span>}
    </div>
  );
}
