/**
 * Workspace screen (I-036): the workspace header, then its main sessions as tabs on the left
 * and the **active main tab's** sub-agents as tabs in a resizable right pane (hidden when it has
 * none). Double-click a tab to maximize its group (again to restore). The layout (tab order,
 * focused tabs, pane width) is saved with the workspace; the URL's `?tab=` is the focused main tab.
 *
 * Tab shortcuts: ⌘T new tab, ⌘W close the focused group's tab, ⌃Tab / ⌃⇧Tab cycle the focused
 * group's tabs ("focused" = the group containing keyboard focus, else the main group).
 */
import { useRef, useState } from "preact/hooks";
import { useNavigate } from "react-router";
import { Check, CircleSlash, Maximize2, Minimize2, Pencil, Plus, X } from "lucide-preact";
import { subagentSessionsOf, type SessionSummary } from "@pi-ui/protocol";
import { TAB_SHORTCUTS, useTabShortcuts } from "@/app/shortcuts";
import { renameFromSession } from "@/state/actions";
import { mainSessionsFor, sessions, workspacesById } from "@/state/store";
import { IconButton, MenuItem, MenuSeparator, SplitView, TabStrip, formatShortcut, type TabStripTab } from "@/ui";
import { ChatHeader } from "@/features/chat/ChatHeader";
import { ChatPane } from "@/features/chat/ChatView";
import { AgentBar } from "./AgentBar";
import { agentDisplay } from "./agent-status";
import { activeSubagentId, clampPaneSize, cycleTab, DEFAULT_SUBAGENT_PANE_SIZE, type TabGroupId } from "./layout";
import {
  closeTab,
  focusMainTab,
  focusSubagentTab,
  maximizedGroup,
  openNewTab,
  saveLayout,
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
  const showSubagents = activeSub !== null && maximized !== "main";
  const showMain = !(maximized === "subagents" && showSubagents);

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
  const close = (session: SessionSummary | undefined, focused: boolean) => {
    if (session) void closeTab(session, navigate, { focused });
  };
  const newTab = () => void openNewTab(workspaceId, navigate);

  useTabShortcuts({
    "new-tab": newTab,
    "close-tab": () => {
      if (focusedGroup() === "subagents") close(subagents.find((s) => s.id === activeSub), true);
      else if (main.length > 1) close(main.find((s) => s.id === sessionId), true);
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
    const canMaximize = group === "subagents" || activeSub !== null;
    const isMax = maximized === group;
    // Sub-agents (I-054): ✓ once done, ⊘ when stopped; the tooltip has the task and result.
    const agent = agentDisplay(s);
    return {
      id: s.id,
      title: tabTitle(s),
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
        tabs={main.map((s) => tabFor(s, "main", main.length > 1))}
        activeId={sessionId}
        panelId={`tabpanel-${workspaceId}-main`}
        onSelect={selectMain}
        onClose={(id) => close(main.find((s) => s.id === id), id === sessionId)}
        onTabDoubleClick={() => activeSub !== null && toggleMaximized(workspaceId, "main")}
        renamingId={renaming}
        onRenameDone={onRenameDone}
        actions={
          <IconButton size="sm" label={`New Tab (${formatShortcut(TAB_SHORTCUTS["new-tab"])})`} onClick={newTab}>
            <Plus />
          </IconButton>
        }
      />
      <div id={`tabpanel-${workspaceId}-main`} role="tabpanel" class="min-h-0 flex-1">
        <ChatPane key={sessionId} sessionId={sessionId} />
      </div>
    </div>
  );

  const subagentGroup = activeSub && (
    <div ref={subagentGroupRef} class="flex h-full min-h-0 flex-col" data-tab-group="subagents">
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
            end={showSubagents ? subagentGroup : null}
            size={paneSize}
            defaultSize={DEFAULT_SUBAGENT_PANE_SIZE}
            label="Resize sub-agents"
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
