/**
 * Pure helpers for workspaces and their sessions (I-035), shared by server and web so both agree
 * on tab order, the default tab and the rolled-up status.
 */
import type { Session, SessionSummary, Workspace, WorkspaceLayout, WorkspaceSummary } from "./api.js";
import { aggregateChatStatus } from "./status.js";

/** Creation order (oldest first), id as a tie-breaker. */
export function compareSessions(a: Pick<Session, "createdAt" | "id">, b: Pick<Session, "createdAt" | "id">): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

/**
 * A workspace's main sessions (tabs) in display order: `layout.mainOrder` first (unknown ids
 * ignored), then the rest by creation.
 */
export function mainSessionsOf<S extends Session>(sessions: readonly S[], workspaceId: string, layout?: WorkspaceLayout | null): S[] {
  const main = sessions.filter((s) => s.workspaceId === workspaceId && s.kind === "main").sort(compareSessions);
  const order = layout?.mainOrder;
  if (!order?.length) return main;
  const rank = new Map(order.map((id, i) => [id, i]));
  return main
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (rank.get(a.s.id) ?? order.length + a.i) - (rank.get(b.s.id) ?? order.length + b.i))
    .map(({ s }) => s);
}

/** Sub-agent sessions spawned by `parentSessionId`, by creation. */
export function subagentSessionsOf<S extends Session>(sessions: readonly S[], parentSessionId: string): S[] {
  return sessions.filter((s) => s.kind === "subagent" && s.parentSessionId === parentSessionId).sort(compareSessions);
}

/** The oldest main session: the one created with the workspace (its title feeds an `auto` workspace title). */
export function firstMainSession<S extends Session>(sessions: readonly S[], workspaceId: string): S | undefined {
  return sessions.filter((s) => s.workspaceId === workspaceId && s.kind === "main").sort(compareSessions)[0];
}

/** The focused main tab: `layout.activeMainSessionId` when it still exists, else the first tab. */
export function activeMainSessionId(workspace: Pick<Workspace, "id" | "layout">, sessions: readonly Session[]): string | null {
  const main = mainSessionsOf(sessions, workspace.id, workspace.layout);
  const wanted = workspace.layout?.activeMainSessionId;
  return (wanted && main.find((s) => s.id === wanted)?.id) || main[0]?.id || null;
}

/** Workspace status rolled up from its sessions (any session of any kind counts). */
export function rollupWorkspace(workspace: Workspace, sessions: readonly SessionSummary[]): WorkspaceSummary {
  const own = sessions.filter((s) => s.workspaceId === workspace.id);
  return {
    ...workspace,
    status: aggregateChatStatus(own.map((s) => s.status)),
    running: own.some((s) => s.running),
    pendingInputs: own.reduce((n, s) => n + s.pendingInputs, 0),
    unread: own.some((s) => s.unread),
    lastRunFailed: own.some((s) => !!s.lastRunFailed),
    interrupted: own.some((s) => !!s.interrupted),
  };
}
