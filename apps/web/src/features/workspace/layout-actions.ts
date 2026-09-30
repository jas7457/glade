/**
 * Workspace tab actions (I-036): save the layout, open/close/focus tabs. The layout is applied
 * to the `workspaces` signal right away (so the UI doesn't wait for the server) and persisted
 * with `updateWorkspace(id, { layout })`. Navigation is passed in by the caller (the URL keeps
 * `?tab=<sessionId>` for the focused main tab).
 *
 * Which group is maximized (double-click a tab) is per window and not saved.
 */
import { signal } from "@preact/signals";
import type { SessionSummary, WorkspaceLayout } from "@glade/protocol";
import { activeMainSessionId, subagentSessionsOf } from "@glade/protocol";
import { chatPath, routes } from "@glade/app-core/app/routes";
import { confirmDeleteChat } from "@/features/sidebar/delete-chat";
import { createSession, deleteSession, updateWorkspace } from "@glade/app-core/state/actions";
import { getChatSession } from "@glade/app-core/state/chat-session";
import { mainSessionsFor, sessions, upsert, workspaces, workspacesById } from "@glade/app-core/state/store";
import { confirm } from "@glade/app-core/ui";
import { notify } from "@glade/app-core/state/toasts";
import { closeTerminal, newTerminalId, startTerminal } from "@/features/terminal";
import { sessionAgentIdentity } from "@glade/app-core/features/chat/agent-identity";
import {
  activeSubagentId,
  isChangesPanelOpen,
  isSubagentPaneOpen,
  addTerminalPatch,
  mainTabsOf,
  mergeLayout,
  neighbourAfterClose,
  openSubagentPatch,
  terminalsOf,
  withoutSession,
  withoutTerminal,
  type TabGroupId,
} from "./layout";

export type Navigate = (path: string, options?: { replace?: boolean }) => void;

/** Maximized tab group per workspace id (the other group is hidden). */
export const maximizedGroup = signal<Record<string, TabGroupId | undefined>>({});

export function toggleMaximized(workspaceId: string, group: TabGroupId): void {
  const current = maximizedGroup.value[workspaceId];
  maximizedGroup.value = { ...maximizedGroup.value, [workspaceId]: current === group ? undefined : group };
}

/** Apply a layout patch locally and persist it. */
export function saveLayout(workspaceId: string, patch: WorkspaceLayout, base?: WorkspaceLayout): Promise<boolean> {
  const workspace = workspacesById.value.get(workspaceId);
  if (!workspace) return Promise.resolve(false);
  const layout = mergeLayout(base ?? workspace.layout, patch);
  workspaces.value = upsert(workspaces.value, { ...workspace, layout });
  return updateWorkspace(workspaceId, { layout });
}

/** Focus a main tab: update the URL and remember it as the workspace's active tab. */
export function focusMainTab(workspaceId: string, sessionId: string, navigate: Navigate): void {
  const workspace = workspacesById.value.get(workspaceId);
  if (!workspace) return;
  navigate(chatPath(workspace, sessionId), { replace: true });
  if (workspace.layout?.activeMainSessionId !== sessionId || workspace.layout?.activeTerminalId) {
    void saveLayout(workspaceId, { activeMainSessionId: sessionId, ...(workspace.layout?.activeTerminalId ? { activeTerminalId: null } : {}) });
  }
}

export function focusSubagentTab(workspaceId: string, mainSessionId: string, sessionId: string): void {
  const saved = workspacesById.value.get(workspaceId)?.layout?.activeSubagentSessionId?.[mainSessionId];
  if (saved !== sessionId) void saveLayout(workspaceId, { activeSubagentSessionId: { [mainSessionId]: sessionId } });
}

/** Open a sub-agent in the right-hand pane (I-080: clicking it in the strip or a report card). */
export function openSubagent(workspaceId: string, mainSessionId: string, sessionId: string): void {
  const layout = workspacesById.value.get(workspaceId)?.layout;
  if (layout?.subagentPaneOpen && !layout.changesPanelOpen && layout.activeSubagentSessionId?.[mainSessionId] === sessionId) return;
  void saveLayout(workspaceId, openSubagentPatch(mainSessionId, sessionId));
}

/** Show/hide the changes panel (I-097; the header's changes button). */
export function setChangesPanelOpen(workspaceId: string, open: boolean): void {
  const layout = workspacesById.value.get(workspaceId)?.layout;
  if ((layout?.changesPanelOpen === true) !== open) void saveLayout(workspaceId, { changesPanelOpen: open });
}

/** Hide the sub-agent pane (its Hide button, Esc, ⌘W, ⌥⌘B, its chip); its agents keep running. */
export function hideSubagentPane(workspaceId: string): void {
  if (maximizedGroup.value[workspaceId] === "subagents") toggleMaximized(workspaceId, "subagents");
  if (workspacesById.value.get(workspaceId)?.layout?.subagentPaneOpen) void saveLayout(workspaceId, { subagentPaneOpen: false });
}

/**
 * Show/hide the sub-agent pane (I-141: ⌥⌘B, the command palette). Opening shows the main tab's
 * focused sub-agent (and restores a maximized main group). Returns what it did: `"opened"`,
 * `"hidden"`, or `null` when the tab has no sub-agents.
 */
export function toggleSubagentPane(workspaceId: string, mainSessionId: string): "opened" | "hidden" | null {
  const layout = workspacesById.value.get(workspaceId)?.layout;
  const maximized = maximizedGroup.value[workspaceId];
  if (isSubagentPaneOpen(layout) && !isChangesPanelOpen(layout) && maximized !== "main") {
    hideSubagentPane(workspaceId);
    return "hidden";
  }
  const ids = subagentSessionsOf(sessions.value, mainSessionId).map((s) => s.id);
  const id = activeSubagentId(layout, mainSessionId, ids);
  if (!id) return null;
  if (maximized === "main") toggleMaximized(workspaceId, "main");
  openSubagent(workspaceId, mainSessionId, id);
  return "opened";
}

/**
 * "+" / ⌘T: a new conversation in the workspace's folder, focused and added at the end. It runs
 * in the same agent as the tab it's opened from (`fromSessionId`, else the workspace's focused tab).
 */
export async function openNewTab(workspaceId: string, navigate: Navigate, fromSessionId?: string | null): Promise<string | null> {
  const main = mainSessionsFor(workspaceId);
  const workspace = workspacesById.value.get(workspaceId);
  // Every tab in the strip, terminals too (I-187), so their places are kept.
  const order = mainTabsOf(
    main.map((s) => s.id),
    workspace?.layout,
  ).map((t) => t.id);
  const fromId = fromSessionId ?? (workspace ? activeMainSessionId(workspace, main) : null);
  const harness = main.find((s) => s.id === fromId)?.harness;
  const detail = await createSession(workspaceId, harness ? { harness } : {});
  if (!detail) return null;
  const id = detail.session.id;
  if (workspace) navigate(chatPath(workspace, id), { replace: true });
  void saveLayout(workspaceId, {
    mainOrder: [...order.filter((x) => x !== id), id],
    activeMainSessionId: id,
    ...(workspace?.layout?.activeTerminalId ? { activeTerminalId: null } : {}),
  });
  return id;
}

// Terminal tabs (I-187) ---------------------------------------------------------------------

/** A new terminal tab (⌃`, the New Tab menu): starts a login shell in the workspace's folder and focuses it. */
export async function openTerminalTab(workspaceId: string, navigate: Navigate): Promise<string | null> {
  const workspace = workspacesById.value.get(workspaceId);
  if (!workspace) return null;
  const id = newTerminalId();
  try {
    await startTerminal(workspaceId, id, { cols: 80, rows: 24 });
  } catch (err) {
    notify("error", `Couldn't open a terminal: ${(err as Error).message}`);
    return null;
  }
  const order = mainTabsOf(
    mainSessionsFor(workspaceId).map((s) => s.id),
    workspace.layout,
  ).map((t) => t.id);
  navigate(chatPath(workspace, id), { replace: true });
  void saveLayout(workspaceId, addTerminalPatch(workspace.layout, order, { id, createdAt: Date.now() }));
  return id;
}

/** Focus a terminal tab (the URL's `?tab=` and the saved `activeTerminalId`). */
export function focusTerminalTab(workspaceId: string, terminalId: string, navigate: Navigate): void {
  const workspace = workspacesById.value.get(workspaceId);
  if (!workspace) return;
  navigate(chatPath(workspace, terminalId), { replace: true });
  if (workspace.layout?.activeTerminalId !== terminalId) void saveLayout(workspaceId, { activeTerminalId: terminalId });
}

/**
 * Close a terminal tab: its shell gets SIGHUP (like closing a terminal window; no confirm). When
 * it was focused, its right (else left) neighbour in the strip takes focus.
 */
export async function closeTerminalTab(workspaceId: string, terminalId: string, navigate: Navigate, opts: { focused: boolean }): Promise<void> {
  const workspace = workspacesById.value.get(workspaceId);
  if (!workspace) return;
  const tabs = mainTabsOf(
    mainSessionsFor(workspaceId).map((s) => s.id),
    workspace.layout,
  );
  const next = tabs.find((t) => t.id === neighbourAfterClose(tabs.map((x) => x.id), terminalId));
  void closeTerminal(workspaceId, terminalId).catch(() => {});
  const layout = withoutTerminal(workspace.layout, terminalId);
  if (opts.focused && next) {
    navigate(chatPath(workspace, next.id), { replace: true });
    void saveLayout(workspaceId, next.kind === "terminal" ? { activeTerminalId: next.id } : { activeMainSessionId: next.id, activeTerminalId: null }, layout);
  } else {
    void saveLayout(workspaceId, {}, layout);
  }
}

/** Rename a terminal tab (empty = back to "Terminal"). */
export function renameTerminalTab(workspaceId: string, terminalId: string, title: string | null): void {
  const layout = workspacesById.value.get(workspaceId)?.layout;
  const terminals = terminalsOf(layout).map((t) => (t.id === terminalId ? { ...t, title: title?.trim() || null } : t));
  void saveLayout(workspaceId, { terminals });
}

/** Whether closing a session loses a conversation (so we ask first). */
export function hasHistory(session: SessionSummary): boolean {
  const store = getChatSession(session.id);
  if (store.status.value === "ready") return store.transcript.value.messages.length > 0;
  return session.lastActivityAt > session.createdAt || session.running;
}

export const tabTitle = (s: Pick<SessionSummary, "title" | "agentName">) => s.title || s.agentName || "New chat";

/**
 * Close a tab (deletes its conversation, and sub-agents it spawned). Asks first when it has
 * history. Focuses the neighbouring tab when the closed one was focused.
 *
 * The last main tab (I-061): a workspace keeps at least one main session, so closing it deletes
 * the whole workspace (always after a confirm) and leaves for the project's new-chat screen, or
 * home for a standalone chat.
 */
export async function closeTab(session: SessionSummary, navigate: Navigate, opts: { focused: boolean }): Promise<boolean> {
  const { workspaceId } = session;
  const main = mainSessionsFor(workspaceId);
  if (session.kind === "main" && main.length <= 1) return closeLastTab(session, navigate);
  const children = subagentSessionsOf(sessions.value, session.id);
  if (hasHistory(session) || children.length > 0) {
    const agents = children.length === 1 ? "its sub-agent" : `its ${children.length} sub-agents`;
    const ok = await confirm({
      title: "Close tab?",
      subject: tabTitle(session),
      message: `${children.length ? `and ${agents} ` : ""}will be permanently deleted. This can't be undone.`,
      confirmLabel: "Close Tab",
      destructive: true,
    });
    if (!ok) return false;
  }
  return deleteTab(session, navigate, opts);
}

/**
 * Remove a sub-agent (I-141: its tab's menu or the AgentBar's ⋯ menu). Sub-agent tabs have no ×,
 * so closing never looks like hiding the pane; this always asks first, even for an empty agent.
 */
export async function removeSubagent(session: SessionSummary): Promise<boolean> {
  const ok = await confirm({
    title: `Remove ${sessionAgentIdentity(session).displayName}?`,
    message: "Stops it if it's running and deletes its conversation. This can't be undone.",
    confirmLabel: "Remove",
    destructive: true,
  });
  if (!ok) return false;
  return deleteTab(session, () => {}, { focused: true });
}

/** Delete a tab's session (already confirmed) and fix up the saved layout / focus. */
async function deleteTab(session: SessionSummary, navigate: Navigate, opts: { focused: boolean }): Promise<boolean> {
  const { workspaceId } = session;
  const main = mainSessionsFor(workspaceId);
  const workspace = workspacesById.value.get(workspaceId);
  const siblings = session.kind === "main" ? main : subagentSessionsOf(sessions.value, session.parentSessionId ?? "");
  const next = neighbourAfterClose(
    siblings.map((s) => s.id),
    session.id,
  );
  if (!(await deleteSession(session.id))) return false;
  const layout = withoutSession(workspace?.layout, session.id);
  if (session.kind === "main") {
    if (opts.focused && next && workspace) navigate(chatPath(workspace, next), { replace: true });
    void saveLayout(workspaceId, opts.focused && next ? { activeMainSessionId: next } : {}, layout);
  } else {
    const parent = session.parentSessionId;
    void saveLayout(workspaceId, parent && next ? { activeSubagentSessionId: { [parent]: next } } : {}, layout);
    // No sub-agents left: un-maximize their (now hidden) group.
    if (!next && maximizedGroup.value[workspaceId] === "subagents") toggleMaximized(workspaceId, "subagents");
  }
  return true;
}

/** Closing the only main tab = deleting the workspace, after a confirm. */
async function closeLastTab(session: SessionSummary, navigate: Navigate): Promise<boolean> {
  const workspace = workspacesById.value.get(session.workspaceId);
  if (!workspace) return false;
  const deleted = await confirmDeleteChat(
    { ...workspace, title: workspace.title || tabTitle(session) },
    { message: "will be permanently deleted, since this is its last tab. This can't be undone.", confirmLabel: "Delete Chat" },
  );
  if (!deleted) return false;
  if (maximizedGroup.value[workspace.id]) {
    const rest = { ...maximizedGroup.value };
    delete rest[workspace.id];
    maximizedGroup.value = rest;
  }
  navigate(workspace.projectId ? routes.project(workspace.projectId) : routes.home(workspace.environmentId), { replace: true });
  return true;
}
