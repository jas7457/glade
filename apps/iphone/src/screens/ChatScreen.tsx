/**
 * One chat, full screen (I-164, doc §5.3): `/e/:envId/chats/:chatId[?tab=<sessionId>]`.
 *
 * Nav bar: the menu button (the chat list over the chat, also a swipe from the left edge), the
 * chat's title and its working / needs-you indicator. Below: the shared transcript full width,
 * the sub-agents as cards, and the touch composer (↩ = new line, Send sends; holding Send offers
 * steer / follow-up / Ask Aside). Pickers open as sheets (`OptionSheetContext` → `SheetList`).
 *
 * `?tab=` a sub-agent's session: that agent's chat full screen with a back button to its parent.
 * The screen pins itself to the visible area above the keyboard (chat/keyboard.ts).
 */
import { ChevronLeft, Menu as MenuIcon } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { subagentSessionsOf, type SessionSummary } from "@glade/protocol";
import { AgentLinksContext, type AgentLinks } from "@glade/app-core/features/chat/agent-links";
import { sessionAgentIdentity } from "@glade/app-core/features/chat/agent-identity";
import { Composer } from "@glade/app-core/features/chat/Composer";
import { OptionSheetContext } from "@glade/app-core/features/chat/option-sheet";
import { Transcript } from "@glade/app-core/features/chat/Transcript";
import { cn } from "@glade/app-core/lib/cn";
import { useChatSession } from "@glade/app-core/state/chat-session";
import { resolveSessionId, sessions, sessionsById, workspacesById } from "@glade/app-core/state/store";
import { Spinner } from "@glade/app-core/ui";
import { paths } from "~/app/routes";
import { useLeftEdgeSwipe } from "~/chat/edge-swipe";
import { useKeyboardViewport } from "~/chat/keyboard";
import { SubagentCards } from "~/chat/SubagentCards";
import { SidebarOverlay } from "~/chats/SidebarOverlay";
import { SheetList } from "~/ui/SheetList";
import { NavBar, NavIconButton } from "~/ui/phone";

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
  const { height, keyboardOpen } = useKeyboardViewport();
  const workspace = workspacesById.value.get(chatId);
  const subagent = subagentTab(chatId, search.get("tab"));
  const sessionId = subagent?.id ?? resolveSessionId(chatId, search.get("tab"));
  const session = sessionId ? sessionsById.value.get(sessionId) : undefined;
  useLeftEdgeSwipe(() => setSidebarOpen(true), !subagent && !sidebarOpen);

  const openSubagent = (id: string) => navigate(paths.chat(envId, chatId, id), { state: { fromParent: true } satisfies ChatLocationState });
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
            <span class="inline-flex max-w-full items-center justify-center gap-1.5">
              <span class="truncate">{title}</span>
              <StatusIndicator session={session} />
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
        />
        <div class="min-h-0 flex-1 border-t-[0.5px] border-separator">
          {sessionId ? <PhoneChatPane key={sessionId} sessionId={sessionId} keyboardOpen={keyboardOpen} onOpenSubagent={openSubagent} /> : null}
        </div>
      </div>
      {!subagent && <SidebarOverlay open={sidebarOpen} onClose={() => setSidebarOpen(false)} />}
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

/** Transcript + sub-agent cards + composer, full width (the phone's ChatPane). */
function PhoneChatPane({ sessionId, keyboardOpen, onOpenSubagent }: { sessionId: string; keyboardOpen: boolean; onOpenSubagent: (id: string) => void }) {
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
          <SubagentCards subagents={subagents} onOpen={onOpenSubagent} />
          <Composer chatId={sessionId} autoFocus={false} />
        </div>
      </div>
    </AgentLinksContext.Provider>
  );
}
