/**
 * Pure helpers for a workspace's tab layout (I-036): which sub-agent tab is focused, which tab
 * to focus after closing one, cycling tabs, and clamping the split size. The layout itself is
 * `Workspace.layout` (stored verbatim by the server); these only compute the next value.
 *
 * Groups: "main" (the workspace's main sessions) and "subagents" (sub-agents spawned by the
 * active main tab). Kept as a string union so more groups/panes can be added later (I-039).
 */
import type { WorkspaceLayout } from "@glade/protocol";

export type TabGroupId = "main" | "subagents";

/** Default width of the sub-agent pane (fraction of the content area). */
export const DEFAULT_SUBAGENT_PANE_SIZE = 0.5;
export const MIN_PANE_FRACTION = 0.2;
export const MAX_PANE_FRACTION = 0.8;

export function clampPaneSize(size: number | undefined | null): number {
  if (typeof size !== "number" || !Number.isFinite(size)) return DEFAULT_SUBAGENT_PANE_SIZE;
  return Math.min(MAX_PANE_FRACTION, Math.max(MIN_PANE_FRACTION, size));
}

/** The focused sub-agent of `mainSessionId`: the saved one if it still exists, else the first. */
export function activeSubagentId(
  layout: WorkspaceLayout | null | undefined,
  mainSessionId: string,
  subagentIds: readonly string[],
): string | null {
  const wanted = layout?.activeSubagentSessionId?.[mainSessionId];
  return (wanted && subagentIds.includes(wanted) ? wanted : subagentIds[0]) ?? null;
}

/** The sub-agent pane is open (I-080): closed unless the user opened an agent from the strip. */
export function isSubagentPaneOpen(layout: WorkspaceLayout | null | undefined): boolean {
  return layout?.subagentPaneOpen === true;
}

/**
 * The saved "pane open" flag should be cleared (I-085): the main session is loaded but has no
 * sub-agents left, so the pane has nothing to show. Otherwise the flag would linger and the next
 * spawn would pop the pane open by itself; new agents only appear in the pane when the user opens one.
 */
export function shouldClearSubagentPane(
  layout: WorkspaceLayout | null | undefined,
  mainSessionLoaded: boolean,
  subagentCount: number,
): boolean {
  return isSubagentPaneOpen(layout) && mainSessionLoaded && subagentCount === 0;
}

/** Layout patch that opens the pane on `subagentId` (a sub-agent of `mainSessionId`). */
export function openSubagentPatch(mainSessionId: string, subagentId: string): WorkspaceLayout {
  return { subagentPaneOpen: true, activeSubagentSessionId: { [mainSessionId]: subagentId } };
}

/** The tab `delta` steps from `current` (wrapping). `null` when there's nothing to move to. */
export function cycleTab(ids: readonly string[], current: string | null, delta: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const from = current ? ids.indexOf(current) : -1;
  if (from === -1) return ids[0] ?? null;
  return ids[(from + delta + ids.length) % ids.length] ?? null;
}

/** The tab to focus after closing `closing`: its right neighbour, else its left one. */
export function neighbourAfterClose(ids: readonly string[], closing: string): string | null {
  const i = ids.indexOf(closing);
  if (i === -1) return ids[0] ?? null;
  return ids[i + 1] ?? ids[i - 1] ?? null;
}

/** Merge a partial layout into the current one (nested `activeSubagentSessionId` merges too). */
export function mergeLayout(current: WorkspaceLayout | null | undefined, patch: WorkspaceLayout): WorkspaceLayout {
  const next: WorkspaceLayout = { ...current, ...patch };
  if (patch.activeSubagentSessionId) {
    next.activeSubagentSessionId = { ...current?.activeSubagentSessionId, ...patch.activeSubagentSessionId };
  }
  return next;
}

/** Drop a closed session from the layout (tab order, focused tabs). */
export function withoutSession(layout: WorkspaceLayout | null | undefined, sessionId: string): WorkspaceLayout {
  const next: WorkspaceLayout = { ...layout };
  if (next.mainOrder) next.mainOrder = next.mainOrder.filter((id) => id !== sessionId);
  if (next.activeMainSessionId === sessionId) next.activeMainSessionId = null;
  if (next.activeSubagentSessionId) {
    next.activeSubagentSessionId = Object.fromEntries(
      Object.entries(next.activeSubagentSessionId).filter(([main, sub]) => main !== sessionId && sub !== sessionId),
    );
  }
  return next;
}
