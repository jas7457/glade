/**
 * One chat, full screen (I-164, doc §5.3): `/e/:envId/chats/:chatId[?tab=<sessionId>]`.
 *
 * Nav bar: the menu button (the chat list over the chat, also a swipe from the left edge), the
 * chat's title and its working / needs-you indicator, and under it the agent (I-176, when its Mac
 * offers several) · model · thinking level (tap: the Model & Thinking sheet, I-172). Below: the shared transcript full width,
 * the sub-agents as cards, and the touch composer (↩ = new line, Send sends; holding Send offers
 * steer / follow-up / Ask Aside). Pickers open as sheets (`OptionSheetContext` → `SheetList`).
 *
 * Bookmarks (I-203): long-press a message to bookmark it (the shared transcript's message menu);
 * the nav bar's bookmark button (with the count, once there is one) lists them (BookmarksSheet).
 *
 * `?tab=` a sub-agent's session: that agent's chat full screen with a back button to its parent.
 * The screen pins itself to the visible area above the keyboard (chat/keyboard.ts).
 */
import { ChevronDown, ChevronLeft, Menu as MenuIcon } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { subagentSessionsOf, type SessionSummary } from "@glade/protocol";
import { AgentLinksContext, type AgentLinks } from "@glade/app-core/features/chat/agent-links";
import { sessionAgentIdentity } from "@glade/app-core/features/chat/agent-identity";
import { chatModelPickerProps } from "@glade/app-core/features/chat/chat-model";
import { Composer } from "@glade/app-core/features/chat/Composer";
import { ModelThinkingPicker } from "@glade/app-core/features/chat/Pickers";
import { OptionSheetContext } from "@glade/app-core/features/chat/option-sheet";
import { Transcript } from "@glade/app-core/features/chat/Transcript";
import { cn } from "@glade/app-core/lib/cn";
import { chatAgentOf } from "@glade/app-core/state/chat-agent";
import { useChatSession } from "@glade/app-core/state/chat-session";
import { resolveSessionId, sessions, sessionsById, workspacesById } from "@glade/app-core/state/store";
import { Spinner } from "@glade/app-core/ui";
import { paths } from "~/app/routes";
import { useLeftEdgeSwipe } from "~/chat/edge-swipe";
import { useKeyboardViewport } from "~/chat/keyboard";
import { SubagentCards } from "~/chat/SubagentCards";
import { BookmarksNavButton, BookmarksSheet } from "~/chat/BookmarksSheet";
import { SidebarOverlay } from "~/chats/SidebarOverlay";
import { SheetList } from "~/ui/SheetList";
import { MacStatusNotice } from "~/ui/MacStatus";
import { NavBar, NavIconButton } from "~/ui/phone";
import { VoiceButton } from "~/voice/VoiceButton";
import { openVoiceMode } from "~/voice/voice-mode";

/** History state when a sub-agent was opened from its parent (Back then pops instead of pushing). */
interface ChatLocationState {
  fromParent?: boolean;
}

/** The session `?tab=` asks for when it's one of this chat's sub-agents. */
function subagentTab(workspaceId: string, tab: string | null): SessionSummary | null {
  const s = tab ? sessionsById.value.get(tab) : undefined;
  return s && s.kind === "subagent" && s.workspaceId === workspaceId ? s : null;
}

export function ChatScreen() {
  const { envId = "", chatId = "" } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const { height, keyboardOpen } = useKeyboardViewport();
  const workspace = workspacesById.value.get(chatId);
  const subagent = subagentTab(chatId, search.get("tab"));
  const sessionId = subagent?.id ?? resolveSessionId(chatId, search.get("tab"));
  const session = sessionId ? sessionsById.value.get(sessionId) : undefined;
  useLeftEdgeSwipe(() => setSidebarOpen(true), !subagent && !sidebarOpen);

  const openSubagent = (id: string) => navigate(paths.chat(envId, chatId, id), { state: { fromParent: true } satisfies ChatLocationState });
  /** Show a session of this chat that holds a bookmark: a main tab, or a sub-agent full screen. */
  const showSession = (id: string) => {
    const s = sessionsById.value.get(id);
    if (!s) return;
    if (s.kind === "subagent") navigate(paths.chat(envId, chatId, id), { state: { fromParent: true } satisfies ChatLocationState });
    else navigate(paths.chat(envId, chatId, id), { replace: true });
  };
  const back = () => {
    if ((location.state as ChatLocationState | null)?.fromParent) navigate(-1);
    else navigate(paths.chat(envId, chatId, subagent?.parentSessionId), { replace: true });
  };

  const title = subagent ? sessionAgentIdentity(subagent).displayName : (workspace?.title ?? "Chat");
  return (
    <OptionSheetContext.Provider value={SheetList}>
      <div
        class="fixed inset-x-0 top-0 flex flex-col overflow-hidden bg-window text-[17px] text-fg"
        style={{ height: height ? `${height}px` : "100%" }}
        data-keyboard-open={keyboardOpen || undefined}
      >
        <NavBar
          title={
            <span class="flex max-w-full flex-col items-center">
              <span class="inline-flex max-w-full items-center justify-center gap-1.5 leading-[21px]">
                <span class="truncate">{title}</span>
                <StatusIndicator session={session} />
              </span>
              {sessionId && <TitleModelLine sessionId={sessionId} />}
            </span>
          }
          left={
            subagent ? (
              <NavIconButton label="Back" onClick={back}>
                <ChevronLeft size={26} />
              </NavIconButton>
            ) : (
              <NavIconButton label="Chats" onClick={() => setSidebarOpen(true)}>
                <MenuIcon size={22} />
              </NavIconButton>
            )
          }
          right={workspace && <BookmarksNavButton workspaceId={workspace.id} onOpen={() => setBookmarksOpen(true)} />}
        />
        <div class="min-h-0 flex-1 border-t-[0.5px] border-separator">
          {sessionId ? (
            <PhoneChatPane key={sessionId} envId={envId} sessionId={sessionId} keyboardOpen={keyboardOpen} onOpenSubagent={openSubagent} />
          ) : (
            // The chat's Mac dropped (its chats leave the store until it reconnects): say so,
            // with Retry, instead of an empty screen (I-170).
            <div class="flex h-full items-center justify-center px-6">
              <MacStatusNotice envId={envId} class="w-full" />
            </div>
          )}
        </div>
      </div>
      {!subagent && <SidebarOverlay open={sidebarOpen} onClose={() => setSidebarOpen(false)} />}
      {workspace && sessionId && (
        <BookmarksSheet open={bookmarksOpen} onClose={() => setBookmarksOpen(false)} workspaceId={workspace.id} sessionId={sessionId} onOpenSession={showSession} />
      )}
    </OptionSheetContext.Provider>
  );
}

/** Spinner while the shown session works, an amber dot when it needs you. */
function StatusIndicator({ session }: { session: SessionSummary | undefined }) {
  if (session?.status === "working") return (
      <span role="status" aria-label="Working" class="flex shrink-0">
        <Spinner size={14} />
      </span>
    );
  if (session?.status === "blocked") return <span role="img" aria-label="Needs you" class="size-2 shrink-0 rounded-full bg-warning" />;
  return null;
}

/**
 * "Opus · Medium ▾" under the title (I-172): opens the composer's Model & Thinking sheet. Not
 * shown for agents that pick their own model, or before the chat has loaded. I-176: led by the
 * chat's agent ("Claude Code · Opus · Medium ▾") when its Mac offers two or more (`chatAgentOf`,
 * the desktop badge's rule); the model truncates first. Agents without a picker: just their name.
 */
function TitleModelLine({ sessionId }: { sessionId: string }) {
  const picker = chatModelPickerProps(sessionId);
  const agent = chatAgentOf(sessionId);
  if (!picker?.model) {
    if (!agent) return null;
    return (
      <span class="-mt-px max-w-full truncate px-1.5 text-[12px] leading-4 font-normal text-fg-muted" title={agent.title}>
        {agent.label}
      </span>
    );
  }
  return (
    <ModelThinkingPicker
      {...picker}
      trigger={(open, label) => (
        <button
          type="button"
          class="pointer-events-auto -mt-px inline-flex max-w-full items-center gap-0.5 rounded-full px-1.5 text-[12px] leading-4 font-normal text-fg-muted active:opacity-60"
          aria-label={`${agent ? `${agent.label}. ` : ""}${label.thinking ? `Model and thinking: ${label.model}, ${label.thinking}` : `Model: ${label.model}`}`}
          onClick={open}
        >
          {/* whitespace-pre: keep the spaces around "·" at the flex items' edges. */}
          {agent && <span class="max-w-[45%] shrink-0 overflow-hidden text-ellipsis whitespace-pre">{`${agent.label} · `}</span>}
          <span class="min-w-0 truncate">{label.model}</span>
          {label.thinking && <span class="shrink-0 whitespace-pre">{` · ${label.thinking}`}</span>}
          {/* A permission mode other than the default (I-174); bypass in red. */}
          {label.mode && <span class={cn("shrink-0 whitespace-pre", label.mode.danger && "text-danger")}>{` · ${label.mode.label}`}</span>}
          <ChevronDown size={11} strokeWidth={2.5} class="shrink-0 opacity-70" />
        </button>
      )}
    />
  );
}

/** Transcript + sub-agent cards + composer, full width (the phone's ChatPane). */
function PhoneChatPane({ envId, sessionId, keyboardOpen, onOpenSubagent }: { envId: string; sessionId: string; keyboardOpen: boolean; onOpenSubagent: (id: string) => void }) {
  // Marks the session as viewed (so finished runs don't turn unread) and loads it.
  useChatSession(sessionId);
  const subagents = subagentSessionsOf(sessions.value, sessionId);
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  useEffect(() => {
    const el = composerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setComposerHeight(Math.round(el.getBoundingClientRect().height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const links: AgentLinks = {
    canOpen: (name) => subagents.some((s) => s.agentName === name),
    open: (name) => {
      const agent = [...subagents].reverse().find((s) => s.agentName === name);
      if (agent) onOpenSubagent(agent.id);
    },
    openSession: (id) => {
      if (subagents.some((s) => s.id === id)) onOpenSubagent(id);
    },
  };
  return (
    <AgentLinksContext.Provider value={links}>
      <div class="relative flex h-full min-h-0 flex-col bg-window">
        {/* The conversation scrolls under the floating glass composer; `bottomInset` keeps its
            last line reachable above it (like ChatGPT / Messages). */}
        <Transcript chatId={sessionId} columnClass="w-full px-3" bottomInset={composerHeight} />
        <div
          ref={composerRef}
          class={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 px-2 pt-1 [&>*]:pointer-events-auto",
            // Above the home indicator with some air, like ChatGPT.
            keyboardOpen ? "pb-2" : "pb-[max(calc(env(safe-area-inset-bottom)_+_4px),16px)]",
          )}
        >
          {/* The chat's Mac dropped (I-170): say what to check, with Retry. */}
          <MacStatusNotice envId={envId} class="mx-1 mb-2 shadow-sm" />
          <SubagentCards subagents={subagents} onOpen={onOpenSubagent} />
          {/* A harness's own sub-agent (I-188) is read-only: no voice mode. */}
          <Composer
            chatId={sessionId}
            autoFocus={false}
            sendAccessory={sessionsById.value.get(sessionId)?.agent?.native ? undefined : <VoiceButton onClick={() => openVoiceMode({ kind: "chat", sessionId })} />}
          />
        </div>
      </div>
    </AgentLinksContext.Provider>
  );
}
