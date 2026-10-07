/**
 * Workspace screen (I-036): the workspace header, then its main sessions as tabs on the left
 * and the **active main tab's** sub-agents as tabs in a resizable right pane.
 *
 * Sub-agents (I-080): the main chat shows a summary strip above its composer; the pane is
 * closed by default (even when agents spawn) and opens when an agent is clicked there or in a
 * report card. Hiding it (its Hide button, Esc or ⌘W inside it, ⌥⌘B, clicking the open agent's
 * chip) leaves the agents running. Sub-agent tabs have no × (I-141): removing one is "Remove
 * Sub-agent…" in its tab's menu or the AgentBar's ⋯ menu, always confirmed. Open state and width are saved in the workspace layout. Double-click a tab to maximize its group (again to restore). The layout (tab order,
 * focused tabs, pane width) is saved with the workspace; the URL's `?tab=` is the focused main tab.
 *
 * Changes panel (I-097): the header's changes button opens it in the right pane, in place of the
 * sub-agents (their pane comes back when it closes; opening an agent closes it). Same width.
 *
 * Bookmarks (I-203): ⌘D bookmarks the focused conversation's latest reply, ⌘⇧D opens the header's
 * bookmark list.
 *
 * Tab shortcuts: ⌘T new tab, ⌘W close the focused group's tab, ⌃Tab / ⌃⇧Tab cycle the focused
 * group's tabs ("focused" = the group containing keyboard focus, else the main group).
 * Every main tab can be closed; closing the last main tab deletes the chat after a confirm (I-061).
 *
 * Terminal tabs (I-187) sit in the main strip next to the conversations (`layout.terminals`,
 * ordered by `mainOrder`): ⌃` or the New Tab menu (the chevron after "+") opens one; `?tab=` /
 * `activeTerminalId` focus it. While a terminal is focused, `sessionId` stays the last focused
 * conversation (the header and the sub-agent pane keep following it).
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { useNavigate } from "react-router";
import { Check, ChevronDown, CircleSlash, Mail, MailOpen, Maximize2, MessageSquarePlus, Minimize2, PanelRightClose, Pencil, Plus, Sparkles, SquareTerminal, Trash2, X } from "lucide-preact";
import { subagentSessionsOf, type SessionSummary } from "@glade/protocol";
import { bookmarkShortcutFor, paneShortcutFor, TAB_SHORTCUTS, TERMINAL_SHORTCUTS, terminalShortcutFor, useNewTerminalMenu, useTabShortcuts } from "@/app/shortcuts";
import { markSessionRead, markSessionUnread, renameFromSession } from "@glade/app-core/state/actions";
import { mainSessionsFor, sessions, workspacesById } from "@glade/app-core/state/store";
import { bookmarkListOpen, toggleLatestReplyBookmark } from "@glade/app-core/state/bookmarks";
import { Button, IconButton, Menu, MenuItem, MenuSeparator, SplitView, TabStrip, Tooltip, formatShortcut, type TabStripTab } from "@glade/app-core/ui";
import type { TerminalTab } from "@glade/protocol";
import { TerminalView, terminalTitles } from "@/features/terminal";
import { ChatHeader } from "@/features/chat/ChatHeader";
import { ChatPane } from "@/features/chat/ChatView";
import { AgentLinksContext, type AgentLinks } from "@glade/app-core/features/chat/agent-links";
import { sessionAgentIdentity } from "@glade/app-core/features/chat/agent-identity";
import { ChangesPanel, useChangesAutoRefresh } from "@/features/changes";
import { AgentBar } from "./AgentBar";
import { SubagentStrip } from "@glade/app-core/features/workspace/SubagentStrip";
import { agentDisplay } from "./agent-status";
import {
  activeSubagentId,
  clampPaneSize,
  cycleTab,
  DEFAULT_SUBAGENT_PANE_SIZE,
  isChangesPanelOpen,
  isSubagentPaneOpen,
  mainTabsOf,
  shouldClearSubagentPane,
  type TabGroupId,
} from "./layout";
import { renameWithAi } from "./rename-with-ai";
import {
  closeTab,
  closeTerminalTab,
  focusMainTab,
  focusTerminalTab,
  focusSubagentTab,
  hideSubagentPane,
  maximizedGroup,
  openNewTab,
  openSubagent,
  openTerminalTab,
  removeSubagent,
  renameTerminalTab,
  saveLayout,
  setChangesPanelOpen,
  tabTitle,
  toggleMaximized,
  toggleSubagentPane,
  type Navigate,
} from "./layout-actions";

export interface WorkspaceViewProps {
  workspaceId: string;
  /** The focused main session (resolved from `?tab=` by the route). */
  sessionId: string;
  /** The focused terminal tab (I-187), shown instead of the conversation; null = none. */
  terminalId?: string | null;
}

export function WorkspaceView({ workspaceId, sessionId, terminalId = null }: WorkspaceViewProps) {
  const routerNavigate = useNavigate();
  const navigate: Navigate = (path, options) => routerNavigate(path, options);
  const workspace = workspacesById.value.get(workspaceId);
  const main = mainSessionsFor(workspaceId);
  // The main strip: conversations and terminals (I-187).
  const mainTabs = mainTabsOf(
    main.map((s) => s.id),
    workspace?.layout,
  );
  const activeMainTab = terminalId ?? sessionId;
  const subagents = subagentSessionsOf(sessions.value, sessionId);
  const activeSub = activeSubagentId(
    workspace?.layout,
    sessionId,
    subagents.map((s) => s.id),
  );
  const activeSubSession = subagents.find((s) => s.id === activeSub);
  const maximized = maximizedGroup.value[workspaceId];
  const paneOpen = isSubagentPaneOpen(workspace?.layout);
  // The changes panel (I-097) takes the right pane's place while open.
  const changesOpen = isChangesPanelOpen(workspace?.layout);
  const showSubagents = paneOpen && !changesOpen && activeSub !== null && maximized !== "main";
  const showMain = !(maximized === "subagents" && showSubagents);
  // The last agent in the pane went away: the pane is closed, so the next spawn doesn't reopen it (I-085).
  const clearPane = shouldClearSubagentPane(
    workspace?.layout,
    sessions.value.some((s) => s.id === sessionId),
    subagents.length,
  );
  useEffect(() => {
    if (clearPane) hideSubagentPane(workspaceId);
  }, [clearPane, workspaceId]);
  // The header's changed-file count stays current (on open and when a run ends).
  useChangesAutoRefresh(workspaceId, workspace?.running);

  // Live pane size while dragging; the saved one otherwise.
  const [dragSize, setDragSize] = useState<number | null>(null);
  const paneSize = dragSize ?? clampPaneSize(workspace?.layout?.subagentPaneSize);
  const [renaming, setRenaming] = useState<string | null>(null);
  const subagentGroupRef = useRef<HTMLDivElement>(null);
  // Only the group the user just picked a tab in takes keyboard focus (the main one by default),
  // so a sub-agent pane appearing doesn't steal the main composer's focus.
  const [subagentFocus, setSubagentFocus] = useState(false);

  const focusedGroup = (): TabGroupId =>
    showSubagents && subagentGroupRef.current?.contains(document.activeElement) ? "subagents" : "main";

  const selectMain = (id: string) => {
    setSubagentFocus(false);
    if (mainTabs.some((t) => t.id === id && t.kind === "terminal")) focusTerminalTab(workspaceId, id, navigate);
    else focusMainTab(workspaceId, id, navigate);
  };
  const selectSub = (id: string) => {
    setSubagentFocus(true);
    focusSubagentTab(workspaceId, sessionId, id);
  };
  const openSub = (id: string) => {
    setSubagentFocus(true);
    openSubagent(workspaceId, sessionId, id);
  };
  const hidePane = () => hideSubagentPane(workspaceId);
  // The strip's chip toggles (I-141): clicking the agent already shown in the pane hides it.
  const onChip = (id: string) => (showSubagents && id === activeSub ? hidePane() : openSub(id));
  // ⌥⌘B shows/hides the pane (I-141).
  const togglePane = useRef(() => {});
  togglePane.current = () => {
    if (toggleSubagentPane(workspaceId, sessionId) === "opened") setSubagentFocus(true);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || paneShortcutFor(e) !== "toggle-subagents") return;
      e.preventDefault();
      togglePane.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // ⌘D bookmarks the focused conversation's latest reply, ⌘⇧D shows the chat's bookmarks (I-203).
  const bookmarkKeys = useRef((_: "bookmark-reply" | "show-bookmarks") => {});
  bookmarkKeys.current = (action) => {
    if (action === "show-bookmarks") {
      bookmarkListOpen.value = bookmarkListOpen.value === workspaceId ? null : workspaceId;
      return;
    }
    const target = focusedGroup() === "subagents" ? activeSub : terminalId ? null : sessionId;
    if (target) void toggleLatestReplyBookmark(target);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = e.defaultPrevented ? null : bookmarkShortcutFor(e);
      if (!action) return;
      e.preventDefault();
      bookmarkKeys.current(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // ⌃` opens a terminal tab (I-187); in the Mac app File → New Terminal (I-192).
  const newTerminal = () => void openTerminalTab(workspaceId, navigate);
  const newTerminalRef = useRef(newTerminal);
  newTerminalRef.current = newTerminal;
  useNewTerminalMenu(newTerminal);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || terminalShortcutFor(e) !== "new-terminal") return;
      e.preventDefault();
      newTerminalRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const agentLinks: AgentLinks = {
    canOpen: (name) => subagents.some((s) => s.agentName === name),
    open: (name) => {
      const agent = subagents.find((s) => s.agentName === name);
      if (agent) openSub(agent.id);
    },
    openSession: (id) => {
      if (subagents.some((s) => s.id === id)) openSub(id);
    },
  };
  const close = (session: SessionSummary | undefined, focused: boolean) => {
    if (session) void closeTab(session, navigate, { focused });
  };
  const closeMainTab = (id: string, focused: boolean) => {
    if (mainTabs.some((t) => t.id === id && t.kind === "terminal")) void closeTerminalTab(workspaceId, id, navigate, { focused });
    else close(main.find((s) => s.id === id), focused);
  };
  const newTab = () => void openNewTab(workspaceId, navigate, sessionId);

  useTabShortcuts({
    "new-tab": newTab,
    "close-tab": () => {
      // ⌘W in the pane hides it; its agents keep running (I-080, I-141: sub-agent tabs don't close).
      if (focusedGroup() === "subagents") hidePane();
      else closeMainTab(activeMainTab, true);
    },
    "next-tab": () => cycle(1),
    "previous-tab": () => cycle(-1),
  });
  function cycle(delta: 1 | -1) {
    if (focusedGroup() === "subagents") {
      const next = cycleTab(
        subagents.map((s) => s.id),
        activeSub,
        delta,
      );
      if (next && next !== activeSub) selectSub(next);
    } else {
      const next = cycleTab(
        mainTabs.map((t) => t.id),
        activeMainTab,
        delta,
      );
      if (next && next !== activeMainTab) selectMain(next);
    }
  }

  const tabFor = (s: SessionSummary, group: TabGroupId, closable: boolean): TabStripTab => {
    const canMaximize = group === "subagents" || showSubagents;
    const isMax = maximized === group;
    // Sub-agents (I-054): ✓ once done, ⊘ when stopped; the tooltip has the task and result.
    const agent = agentDisplay(s);
    // Sub-agents (I-084): fun name in its colour, then its generated title (I-148) or role greyed,
    // unless the user renamed the tab.
    const identity = s.kind === "subagent" ? sessionAgentIdentity(s) : null;
    const retitled = !!identity && !!s.title && s.title !== s.agentName;
    const renamed = retitled && s.titleSource === "user";
    return {
      id: s.id,
      title: identity && !renamed ? identity.displayName : tabTitle(s),
      subtitle: identity && !renamed ? ((retitled ? s.title : identity.role) ?? undefined) : undefined,
      agentColor: identity?.color,
      status: s.status,
      failed: s.lastRunFailed,
      badge:
        agent?.kind === "done" ? (
          <Check class="text-success" aria-label="Done" />
        ) : agent?.kind === "closed" ? (
          <CircleSlash aria-label="Stopped" />
        ) : null,
      tooltip: agent?.tooltip,
      closable,
      contextMenu: (
        <>
          <MenuItem icon={<Pencil />} onSelect={() => setRenaming(s.id)}>
            Rename…
          </MenuItem>
          <MenuItem icon={<Sparkles />} onSelect={() => void renameWithAi(s.id)}>
            Rename with AI
          </MenuItem>
          {s.unread ? (
            <MenuItem icon={<MailOpen />} onSelect={() => void markSessionRead(s.id)}>
              Mark as Read
            </MenuItem>
          ) : (
            <MenuItem icon={<Mail />} onSelect={() => void markSessionUnread(s.id)}>
              Mark as Unread
            </MenuItem>
          )}
          {canMaximize && (
            <MenuItem icon={isMax ? <Minimize2 /> : <Maximize2 />} onSelect={() => toggleMaximized(workspaceId, group)}>
              {isMax ? "Restore Layout" : "Maximize"}
            </MenuItem>
          )}
          {group === "subagents" && (
            <>
              <MenuSeparator />
              <MenuItem icon={<Trash2 />} destructive onSelect={() => void removeSubagent(s)}>
                Remove Sub-agent…
              </MenuItem>
            </>
          )}
          {closable && (
            <>
              <MenuSeparator />
              <MenuItem icon={<X />} onSelect={() => close(s, s.id === (group === "main" ? sessionId : activeSub))}>
                Close Tab
              </MenuItem>
            </>
          )}
        </>
      ),
    };
  };

  const mainMaximized = maximizedGroup.value[workspaceId] === "main";
  const terminalTabFor = (t: TerminalTab): TabStripTab => {
    const shellTitle = terminalTitles.value[t.id];
    const title = t.title || "Terminal";
    return {
      id: t.id,
      title,
      subtitle: !t.title && shellTitle ? shellTitle : undefined,
      tooltip: shellTitle ? `${title} — ${shellTitle}` : title,
      status: "idle",
      icon: <SquareTerminal aria-label="Terminal" />,
      closable: true,
      contextMenu: (
        <>
          <MenuItem icon={<Pencil />} onSelect={() => setRenaming(t.id)}>
            Rename…
          </MenuItem>
          {showSubagents && (
            <MenuItem icon={mainMaximized ? <Minimize2 /> : <Maximize2 />} onSelect={() => toggleMaximized(workspaceId, "main")}>
              {mainMaximized ? "Restore Layout" : "Maximize"}
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem icon={<X />} onSelect={() => closeMainTab(t.id, t.id === activeMainTab)}>
            Close Tab
          </MenuItem>
        </>
      ),
    };
  };

  const onRenameDone = (id: string, title: string | null) => {
    setRenaming(null);
    if (mainTabs.some((t) => t.id === id && t.kind === "terminal")) {
      if (title !== null) renameTerminalTab(workspaceId, id, title);
      return;
    }
    if (title) void renameFromSession(id, title);
  };

  const mainGroup = (
    <div class="flex h-full min-h-0 flex-col" data-tab-group="main">
      <TabStrip
        label="Conversations"
        tabs={mainTabs.flatMap((t) => {
          if (t.kind === "terminal") return [terminalTabFor(t.terminal)];
          const s = main.find((m) => m.id === t.id);
          return s ? [tabFor(s, "main", true)] : [];
        })}
        activeId={activeMainTab}
        panelId={`tabpanel-${workspaceId}-main`}
        onSelect={selectMain}
        onClose={(id) => closeMainTab(id, id === activeMainTab)}
        onTabDoubleClick={() => showSubagents && toggleMaximized(workspaceId, "main")}
        renamingId={renaming}
        onRenameDone={onRenameDone}
        actions={
          <>
            <IconButton size="sm" label={`New Tab (${formatShortcut(TAB_SHORTCUTS["new-tab"])})`} onClick={newTab}>
              <Plus />
            </IconButton>
            {/* The New Tab menu (I-187): the kinds of tab, with their shortcuts. */}
            <Menu
              align="end"
              trigger={
                <IconButton size="sm" label="Tab Menu" class="-ml-0.5 w-4 [&_svg]:size-3">
                  <ChevronDown />
                </IconButton>
              }
            >
              <MenuItem icon={<MessageSquarePlus />} shortcut={formatShortcut(TAB_SHORTCUTS["new-tab"])} onSelect={newTab}>
                New Conversation
              </MenuItem>
              <MenuItem icon={<SquareTerminal />} shortcut={formatShortcut(TERMINAL_SHORTCUTS["new-terminal"])} onSelect={newTerminal}>
                New Terminal
              </MenuItem>
            </Menu>
          </>
        }
      />
      <div id={`tabpanel-${workspaceId}-main`} role="tabpanel" class="min-h-0 flex-1">
        {terminalId ? (
          <TerminalView key={terminalId} workspaceId={workspaceId} terminalId={terminalId} />
        ) : (
          <AgentLinksContext.Provider value={agentLinks}>
            <ChatPane
              key={sessionId}
              sessionId={sessionId}
              aboveComposer={<SubagentStrip subagents={subagents} openId={showSubagents ? activeSub : null} onOpen={onChip} />}
            />
          </AgentLinksContext.Provider>
        )}
      </div>
    </div>
  );

  const subagentGroup = activeSub && (
    <div
      ref={subagentGroupRef}
      class="flex h-full min-h-0 flex-col"
      data-tab-group="subagents"
      onKeyDown={(e) => {
        // Esc hides the pane unless something inside used it (stopping a run, closing a menu…).
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          hidePane();
        }
      }}
    >
      <TabStrip
        label="Sub-agents"
        tabs={subagents.map((s) => tabFor(s, "subagents", false))}
        activeId={activeSub}
        panelId={`tabpanel-${workspaceId}-subagents`}
        onSelect={selectSub}
        onTabDoubleClick={() => toggleMaximized(workspaceId, "subagents")}
        renamingId={renaming}
        onRenameDone={onRenameDone}
        actions={
          // I-141: a labelled Hide (not an icon where a × is expected), so it can't pass for "close".
          <Tooltip content="Hide Sub-agents (Esc)">
            <Button variant="ghost" size="sm" aria-label="Hide Sub-agents (Esc)" onClick={hidePane} class="px-1.5 text-fg-muted hover:text-fg [&_svg]:size-3.5">
              <PanelRightClose />
              Hide
            </Button>
          </Tooltip>
        }
      />
      <div id={`tabpanel-${workspaceId}-subagents`} role="tabpanel" class="flex min-h-0 flex-1 flex-col">
        {activeSubSession && <AgentBar key={activeSub} session={activeSubSession} />}
        <div class="min-h-0 flex-1">
          <ChatPane key={activeSub} sessionId={activeSub} autoFocus={subagentFocus} />
        </div>
      </div>
    </div>
  );

  return (
    <div class="flex h-full min-h-0 flex-col bg-window">
      <ChatHeader workspace={workspace} sessionId={sessionId} />
      <div class="min-h-0 flex-1">
        {showMain ? (
          <SplitView
            start={mainGroup}
            end={
              changesOpen && workspace ? (
                <ChangesPanel workspaceId={workspaceId} cwd={workspace.cwd} onClose={() => setChangesPanelOpen(workspaceId, false)} />
              ) : showSubagents ? (
                subagentGroup
              ) : null
            }
            size={paneSize}
            defaultSize={DEFAULT_SUBAGENT_PANE_SIZE}
            label={changesOpen ? "Resize changes" : "Resize sub-agents"}
            onResize={setDragSize}
            onResizeEnd={(size) => {
              setDragSize(null);
              if (size !== workspace?.layout?.subagentPaneSize) void saveLayout(workspaceId, { subagentPaneSize: size });
            }}
          />
        ) : (
          subagentGroup
        )}
      </div>
    </div>
  );
}
