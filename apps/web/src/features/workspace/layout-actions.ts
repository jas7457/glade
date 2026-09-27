/**
 * Workspace tab actions (I-036): save the layout, open/close/focus tabs. The layout is applied
 * to the `workspaces` signal right away (so the UI doesn't wait for the server) and persisted
 * with `updateWorkspace(id, { layout })`. Navigation is passed in by the caller (the URL keeps
 * `?tab=<sessionId>` for the focused main tab).
 *
 * Which group is maximized (double-click a tab) is per window and not saved.
 */
import { signal } from "@preact/signals";
import type { SessionSummary, WorkspaceLayout } from "@pi-ui/protocol";
import { subagentSessionsOf } from "@pi-ui/protocol";
import { chatPath, routes } from "@/app/routes";
import { createSession, deleteSession, deleteWorkspace, updateWorkspace } from "@/state/actions";
import { getChatSession } from "@/state/chat-session";
import { mainSessionsFor, sessions, upsert, workspaces, workspacesById } from "@/state/store";
import { confirm } from "@/ui";
import { mergeLayout, neighbourAfterClose, withoutSession, type TabGroupId } from "./layout";

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
  if (workspace.layout?.activeMainSessionId !== sessionId) void saveLayout(workspaceId, { activeMainSessionId: sessionId });
}

export function focusSubagentTab(workspaceId: string, mainSessionId: string, sessionId: string): void {
  const saved = workspacesById.value.get(workspaceId)?.layout?.activeSubagentSessionId?.[mainSessionId];
  if (saved !== sessionId) void saveLayout(workspaceId, { activeSubagentSessionId: { [mainSessionId]: sessionId } });
}

/** "+" / ⌘T: a new conversation in the workspace's folder, focused and added at the end. */
export async function openNewTab(workspaceId: string, navigate: Navigate): Promise<string | null> {
  const order = mainSessionsFor(workspaceId).map((s) => s.id);
  const detail = await createSession(workspaceId);
  if (!detail) return null;
  const id = detail.session.id;
  const workspace = workspacesById.value.get(workspaceId);
  if (workspace) navigate(chatPath(workspace, id), { replace: true });
  void saveLayout(workspaceId, { mainOrder: [...order.filter((x) => x !== id), id], activeMainSessionId: id });
  return id;
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
      title: `Close “${tabTitle(session)}”?`,
      message: `The conversation${children.length ? ` and ${agents}` : ""} will be permanently deleted. This can't be undone.`,
      confirmLabel: "Close Tab",
      destructive: true,
    });
    if (!ok) return false;
  }
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
  const ok = await confirm({
    title: `Delete “${workspace.title || tabTitle(session)}”?`,
    message: "This is the last tab, so the whole chat will be deleted. This can't be undone.",
    confirmLabel: "Delete Chat",
    destructive: true,
  });
  if (!ok || !(await deleteWorkspace(workspace.id))) return false;
  if (maximizedGroup.value[workspace.id]) {
    const rest = { ...maximizedGroup.value };
    delete rest[workspace.id];
    maximizedGroup.value = rest;
  }
  navigate(workspace.projectId ? routes.project(workspace.projectId) : routes.home(), { replace: true });
  return true;
}
