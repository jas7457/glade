/**
 * Scrolling transcript for one chat. Reusable anywhere: give it a `chatId`.
 *
 * Renders the items produced by `groupTranscript` (grouping.ts): user bubbles (sub-agent reports
 * as cards, AgentMessageCard.tsx), sub-agent spawns as agent cards that also absorb the agent's
 * later messages (AgentSpawnCard.tsx, agent-spawns.ts, I-084), assistant turns (markdown, thinking, tool rows/groups,
 * errors), the user's shell commands (ShellCard.tsx), plans (PlanCard.tsx) and notices. Sticks to the bottom while
 * streaming unless the user scrolls up, in which case a "Jump to latest" button appears.
 *
 * The "Working…" row at the bottom stays for the whole run (working.ts) and shows the run's
 * elapsed time; streamed reply text is revealed smoothly (smooth-text.ts).
 *
 * In a sub-agent's own transcript its task and the parent's messages are cards (DelegatedCard,
 * delegated.ts, I-109). Messages show their time on hover and a divider marks each new day
 * (MessageTime.tsx, I-111); images open in a lightbox (I-110).
 */
import { Fragment } from "preact";
import { memo } from "preact/compat";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ArrowDown, CircleAlert, Info, ListChecks, OctagonX, Scissors, TriangleAlert } from "lucide-preact";
import { subagentSessionsOf, type AgentColor, type NoticeMessage } from "@glade/protocol";
import { cn } from "@/lib/cn";
import { loadChatSession, useChatSession } from "@/state/chat-session";
import { sessions } from "@/state/store";
import { Button, Disclosure, Spinner } from "@/ui";
import { formatDuration, useNow } from "./duration";
import { DEFAULT_GROUPING_OPTIONS, groupTranscript, type GroupingOptions, type RenderItem, type TurnPart } from "./grouping";
import { ImageThumb, UserBubble } from "./UserBubble";
import { AgentSpawnCard } from "./AgentSpawnCard";
import { linkAgentSpawns } from "./agent-spawns";
import { SpawnLinksContext, type SpawnLinksValue } from "./spawn-context";
import { sessionAgentIdentity } from "./agent-identity";
import { delegatedMessage, taskMessageId } from "./delegated";
import { DelegatedCard } from "./DelegatedCard";
import { DayDivider, MessageTime } from "./MessageTime";
import { dayDividers } from "./message-time";
import { useImageLightbox } from "./ImageLightbox";
import { ShellCard } from "./ShellCard";
import { PlanCard } from "./PlanCard";
import { Markdown } from "./Markdown";
import { ThinkingView } from "./Thinking";
import { ToolCallRow, ToolGroup } from "./tools/ToolViews";
import { useSmoothText } from "./smooth-text";
import { useStickToBottom } from "./useStickToBottom";
import { findJumpTarget, flashElement, jumpElement, pendingJump, takeJump } from "./jump-to-message";
import { notify } from "@/state/toasts";
import { workingStatus, type WorkingLabel } from "./working";
import "./chat.css";

export { UserBubble } from "./UserBubble";

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

  // Sub-agents spawned here (I-084): spawn calls become agent cards; their messages fold into them.
  const allSessions = sessions.value;
  const refs = useMemo(() => allSessions.find((s) => s.id === chatId)?.spawnedAgents ?? [], [allSessions, chatId]);
  const subagents = useMemo(() => subagentSessionsOf(allSessions, chatId), [allSessions, chatId]);
  const links = useMemo(() => linkAgentSpawns(transcript, refs), [transcript, refs]);
  const spawnValue = useMemo<SpawnLinksValue>(() => ({ links, subagents, refs }), [links, subagents, refs]);
  const items = useMemo(
    () => groupTranscript(transcript, { isRunning }, grouping).filter((i) => !(i.type === "user" && links.hidden.has(i.message.id))),
    [transcript, isRunning, grouping, links],
  );
  const dividers = useMemo(() => dayDividers(items.map(itemTimestamp), Date.now()), [items]);

  // A sub-agent's own transcript (I-109): its task and the parent's messages become cards.
  const session = allSessions.find((s) => s.id === chatId);
  const isSubagent = session?.kind === "subagent";
  const parentTitle = isSubagent ? (allSessions.find((s) => s.id === session.parentSessionId)?.title ?? null) : null;
  const subagentColor = isSubagent ? sessionAgentIdentity(session).color : null;
  const taskId = useMemo(() => (isSubagent ? taskMessageId(transcript.messages, session.agent?.task) : null), [isSubagent, transcript.messages, session?.agent?.task]);
  const delegation = useMemo<Delegation | null>(
    () => (isSubagent ? { taskId, parentTitle, color: subagentColor } : null),
    [isSubagent, taskId, parentTitle, subagentColor],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { atBottom, scrollToBottom, scrollToElement } = useStickToBottom(scrollRef, contentRef);

  // Jump to the bottom when the user sends a message or runs a command, and when switching chats.
  const lastUserId = useMemo(() => {
    for (let i = transcript.messages.length - 1; i >= 0; i--) {
      const m = transcript.messages[i]!;
      if (m.role === "user" || m.role === "shell") return m.id;
    }
    return null;
  }, [transcript.messages]);
  useEffect(() => scrollToBottom(), [lastUserId, chatId, status === "ready"]);

  // Opened from a search hit (I-093): center the matched message and flash it. Runs after the
  // jump to the bottom above, so it wins for this open; stays at the bottom if it isn't loaded.
  const jump = pendingJump.value;
  useEffect(() => {
    if (status !== "ready" || !jump || jump.sessionId !== chatId) return;
    const anchor = takeJump(chatId);
    if (!anchor) return;
    const target = findJumpTarget(transcript.messages, items, anchor);
    const el = target && contentRef.current ? jumpElement(contentRef.current, target) : null;
    if (!el) return notify("info", "Message not in loaded history");
    scrollToElement(el);
    flashElement(el);
  }, [jump, chatId, status]);

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
          <SpawnLinksContext.Provider value={spawnValue}>
            {items.map((item, i) => (
              <Fragment key={item.key}>
                {dividers[i] && <DayDivider label={dividers[i]} />}
                <ItemView item={item} chatId={chatId} delegation={delegation} />
              </Fragment>
            ))}
          </SpawnLinksContext.Provider>
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

/** How a sub-agent's transcript shows what its parent delegated (I-109). */
interface Delegation {
  taskId: string | null;
  parentTitle: string | null;
  color: AgentColor | null;
}

function itemTimestamp(item: RenderItem): number {
  return item.type === "turn" ? item.timestamp : item.message.timestamp;
}

function ItemView({ item, chatId, delegation }: { item: RenderItem; chatId: string; delegation: Delegation | null }) {
  switch (item.type) {
    case "user": {
      const delegated = delegation ? delegatedMessage(item.message, delegation.taskId) : null;
      if (delegated) {
        return <DelegatedCard message={delegated} timestamp={item.message.timestamp} parentTitle={delegation!.parentTitle} color={delegation!.color} />;
      }
      return <UserBubble message={item.message} />;
    }
    case "notice":
      // A plan (I-119) is a checklist card; other notices are divider rows.
      if (item.message.kind === "plan" && item.message.plan) return <PlanCard entries={item.message.plan} />;
      return <NoticeRow message={item.message} />;
    case "shell":
      return <ShellCard message={item.message} chatId={chatId} />;
    case "turn":
      return <TurnView parts={item.parts} timestamp={item.timestamp} />;
  }
}

function TurnView({ parts, timestamp }: { parts: TurnPart[]; timestamp: number }) {
  const images = useMemo(() => parts.flatMap((p) => (p.type === "image" ? [p.image] : [])), [parts]);
  const { open, lightbox } = useImageLightbox(images);
  let imageIndex = 0;
  return (
    <div class="group/msg relative mt-4 flex flex-col first:mt-0" data-role="assistant">
      {parts.map((part) => {
        const index = part.type === "image" ? imageIndex++ : -1;
        return <PartView key={part.key} part={part} onOpenImage={index === -1 ? undefined : () => open(index)} />;
      })}
      {/* Last child, so jump-to-message's part indices still match (I-093). */}
      <MessageTime timestamp={timestamp} class="absolute top-full left-0" />
      {lightbox}
    </div>
  );
}

function PartView({ part, onOpenImage }: { part: TurnPart; onOpenImage?: () => void }) {
  switch (part.type) {
    case "text":
      return <ReplyText text={part.text} streaming={part.streaming} />;
    case "thinking":
      return <ThinkingView text={part.text} streaming={part.streaming} />;
    case "tool":
      return part.call.kind === "task" ? <AgentSpawnCard part={part} /> : <ToolCallRow part={part} />;
    case "toolGroup":
      return <ToolGroup part={part} />;
    case "image":
      return (
        <div class="my-1.5 flex">
          <ImageThumb image={part.image} class="max-h-80" onOpen={onOpenImage} />
        </div>
      );
    case "error":
      return <ErrorNotice kind={part.kind} message={part.message} details={part.details} />;
  }
}

/** Assistant reply text; revealed smoothly while it streams (I-072). */
function ReplyText({ text, streaming }: { text: string; streaming: boolean }) {
  const shown = useSmoothText(text, streaming);
  // Still revealing after the message ended: keep tolerating unterminated markdown until done.
  return <Markdown text={shown} streaming={streaming || shown.length < text.length} class="my-1.5" />;
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

const noticeIcons = { info: Info, warning: TriangleAlert, error: CircleAlert, compaction: Scissors, plan: ListChecks } as const;

export const NoticeRow = memo(function NoticeRow({ message }: { message: NoticeMessage }) {
  const Icon = noticeIcons[message.kind];
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
