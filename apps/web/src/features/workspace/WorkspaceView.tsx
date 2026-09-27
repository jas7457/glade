/**
 * Workspace screen (I-036): the workspace header, then its main sessions as tabs on the left
 * and the **active main tab's** sub-agents as tabs in a resizable right pane.
 *
 * Sub-agents (I-080): the main chat shows a summary strip above its composer; the pane is
 * closed by default (even when agents spawn) and opens when an agent is clicked there or in a
 * report card. Hiding it (its × button, Esc inside it, ⌘W on its last tab) leaves the agents
 * running. Open state and width are saved in the workspace layout. Double-click a tab to maximize its group (again to restore). The layout (tab order,
 * focused tabs, pane width) is saved with the workspace; the URL's `?tab=` is the focused main tab.
 *
 * Changes panel (I-097): the header's changes button opens it in the right pane, in place of the
 * sub-agents (their pane comes back when it closes; opening an agent closes it). Same width.
 *
 * Tab shortcuts: ⌘T new tab, ⌘W close the focused group's tab, ⌃Tab / ⌃⇧Tab cycle the focused
 * group's tabs ("focused" = the group containing keyboard focus, else the main group).
 * Every tab can be closed; closing the last main tab deletes the chat after a confirm (I-061).
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { useNavigate } from "react-router";
import { Check, CircleSlash, Mail, MailOpen, Maximize2, Minimize2, PanelRightClose, Pencil, Plus, Sparkles, X } from "lucide-preact";
import { subagentSessionsOf, type SessionSummary } from "@glade/protocol";
import { TAB_SHORTCUTS, useTabShortcuts } from "@/app/shortcuts";
import { markSessionRead, markSessionUnread, renameFromSession } from "@/state/actions";
import { mainSessionsFor, sessions, workspacesById } from "@/state/store";
import { IconButton, MenuItem, MenuSeparator, SplitView, TabStrip, formatShortcut, type TabStripTab } from "@/ui";
import { ChatHeader } from "@/features/chat/ChatHeader";
import { ChatPane } from "@/features/chat/ChatView";
import { AgentLinksContext, type AgentLinks } from "@/features/chat/agent-links";
import { sessionAgentIdentity } from "@/features/chat/agent-identity";
import { ChangesPanel, useChangesAutoRefresh } from "@/features/changes";
import { AgentBar } from "./AgentBar";
import { SubagentStrip } from "./SubagentStrip";
import { agentDisplay } from "./agent-status";
import { activeSubagentId, clampPaneSize, cycleTab, DEFAULT_SUBAGENT_PANE_SIZE, isChangesPanelOpen, isSubagentPaneOpen, shouldClearSubagentPane, type TabGroupId } from "./layout";
import { renameWithAi } from "./rename-with-ai";
import {
  closeTab,
  focusMainTab,
  focusSubagentTab,
  hideSubagentPane,
  maximizedGroup,
  openNewTab,
  openSubagent,
  saveLayout,
  setChangesPanelOpen,
  tabTitle,
  toggleMaximized,
  type Navigate,
} from "./layout-actions";

export interface WorkspaceViewProps {
  workspaceId: string;
  /** The focused main session (resolved from `?tab=` by the route). */
  sessionId: string;
}

export function WorkspaceView({ workspaceId, sessionId }: WorkspaceViewProps) {
  const routerNavigate = useNavigate();
  const navigate: Navigate = (path, options) => routerNavigate(path, options);
  const workspace = workspacesById.value.get(workspaceId);
  const main = mainSessionsFor(workspaceId);
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
    focusMainTab(workspaceId, id, navigate);
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
  const newTab = () => void openNewTab(workspaceId, navigate);

  useTabShortcuts({
    "new-tab": newTab,
    "close-tab": () => {
      // ⌘W on the pane's last tab hides the pane; the agent keeps running (I-080).
      if (focusedGroup() === "subagents") {
        if (subagents.length <= 1) hidePane();
        else close(subagents.find((s) => s.id === activeSub), true);
      }
      else close(main.find((s) => s.id === sessionId), true);
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
        main.map((s) => s.id),
        sessionId,
        delta,
      );
      if (next && next !== sessionId) selectMain(next);
    }
  }

  const tabFor = (s: SessionSummary, group: TabGroupId, closable: boolean): TabStripTab => {
    const canMaximize = group === "subagents" || showSubagents;
    const isMax = maximized === group;
    // Sub-agents (I-054): ✓ once done, ⊘ when stopped; the tooltip has the task and result.
    const agent = agentDisplay(s);
    // Sub-agents (I-084): fun name in its colour, role greyed, unless the user renamed the tab.
    const identity = s.kind === "subagent" ? sessionAgentIdentity(s) : null;
    const renamed = !!identity && !!s.title && s.title !== s.agentName;
    return {
      id: s.id,
      title: identity && !renamed ? identity.displayName : tabTitle(s),
      subtitle: identity && !renamed ? (identity.role ?? undefined) : undefined,
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

  const onRenameDone = (id: string, title: string | null) => {
    setRenaming(null);
    if (title) void renameFromSession(id, title);
  };

  const mainGroup = (
    <div class="flex h-full min-h-0 flex-col" data-tab-group="main">
      <TabStrip
        label="Conversations"
        tabs={main.map((s) => tabFor(s, "main", true))}
        activeId={sessionId}
        panelId={`tabpanel-${workspaceId}-main`}
        onSelect={selectMain}
        onClose={(id) => close(main.find((s) => s.id === id), id === sessionId)}
        onTabDoubleClick={() => showSubagents && toggleMaximized(workspaceId, "main")}
        renamingId={renaming}
        onRenameDone={onRenameDone}
        actions={
          <IconButton size="sm" label={`New Tab (${formatShortcut(TAB_SHORTCUTS["new-tab"])})`} onClick={newTab}>
            <Plus />
          </IconButton>
        }
      />
      <div id={`tabpanel-${workspaceId}-main`} role="tabpanel" class="min-h-0 flex-1">
        <AgentLinksContext.Provider value={agentLinks}>
          <ChatPane
            key={sessionId}
            sessionId={sessionId}
            aboveComposer={<SubagentStrip subagents={subagents} openId={showSubagents ? activeSub : null} onOpen={openSub} />}
          />
        </AgentLinksContext.Provider>
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
        tabs={subagents.map((s) => tabFor(s, "subagents", true))}
        activeId={activeSub}
        panelId={`tabpanel-${workspaceId}-subagents`}
        onSelect={selectSub}
        onClose={(id) => close(subagents.find((s) => s.id === id), id === activeSub)}
        onTabDoubleClick={() => toggleMaximized(workspaceId, "subagents")}
        renamingId={renaming}
        onRenameDone={onRenameDone}
        actions={
          <IconButton size="sm" label="Hide Sub-agents (Esc)" onClick={hidePane}>
            <PanelRightClose />
          </IconButton>
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
