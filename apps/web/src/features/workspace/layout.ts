/**
 * Pure helpers for a workspace's tab layout (I-036): which sub-agent tab is focused, which tab
 * to focus after closing one, cycling tabs, and clamping the split size. The layout itself is
 * `Workspace.layout` (stored verbatim by the server); these only compute the next value.
 *
 * Groups: "main" (the workspace's main sessions) and "subagents" (sub-agents spawned by the
 * active main tab). Kept as a string union so more groups/panes can be added later (I-039).
 */
import type { TerminalTab, WorkspaceLayout } from "@glade/protocol";

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

/**
 * Layout patch that opens the pane on `subagentId` (a sub-agent of `mainSessionId`). The changes
 * panel shares the right side (I-097), so opening an agent closes it.
 */
export function openSubagentPatch(mainSessionId: string, subagentId: string): WorkspaceLayout {
  return { subagentPaneOpen: true, changesPanelOpen: false, activeSubagentSessionId: { [mainSessionId]: subagentId } };
}

/**
 * The changes panel is open (I-097). It takes the right pane's place while open; the sub-agent
 * pane's own open flag is kept, so closing the changes panel brings the agents back.
 */
export function isChangesPanelOpen(layout: WorkspaceLayout | null | undefined): boolean {
  return layout?.changesPanelOpen === true;
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

// Terminal tabs (I-187) ---------------------------------------------------------------------

/** A main-strip tab: a conversation (session) or a terminal. */
export type MainTab = { kind: "session"; id: string } | { kind: "terminal"; id: string; terminal: TerminalTab };

export function terminalsOf(layout: WorkspaceLayout | null | undefined): TerminalTab[] {
  return Array.isArray(layout?.terminals) ? layout.terminals.filter((t) => t && typeof t.id === "string") : [];
}

export function isTerminalTab(layout: WorkspaceLayout | null | undefined, id: string | null | undefined): boolean {
  return !!id && terminalsOf(layout).some((t) => t.id === id);
}

/**
 * The main strip's tabs in display order: `sessionIds` (already in their order) and the
 * terminals, placed by `layout.mainOrder`; tabs missing from it go after (terminals last).
 */
export function mainTabsOf(sessionIds: readonly string[], layout: WorkspaceLayout | null | undefined): MainTab[] {
  const order = layout?.mainOrder ?? [];
  const rank = new Map(order.map((id, i) => [id, i]));
  const items: Array<{ tab: MainTab; key: number; i: number }> = [];
  sessionIds.forEach((id, i) => items.push({ tab: { kind: "session", id }, key: rank.get(id) ?? order.length + i, i }));
  terminalsOf(layout).forEach((terminal, j) =>
    items.push({ tab: { kind: "terminal", id: terminal.id, terminal }, key: rank.get(terminal.id) ?? order.length + sessionIds.length + j, i: sessionIds.length + j }),
  );
  return items.sort((a, b) => a.key - b.key || a.i - b.i).map((x) => x.tab);
}

/**
 * The focused terminal: the URL's `?tab=` when it names one (a session there means no terminal),
 * else the saved `activeTerminalId` if that terminal still exists.
 */
export function activeTerminalId(layout: WorkspaceLayout | null | undefined, tab: string | null | undefined): string | null {
  if (tab) return isTerminalTab(layout, tab) ? tab : null;
  const saved = layout?.activeTerminalId;
  return saved && isTerminalTab(layout, saved) ? saved : null;
}

/** Layout patch that adds a terminal tab at the end of the strip and focuses it. */
export function addTerminalPatch(layout: WorkspaceLayout | null | undefined, allTabIds: readonly string[], terminal: TerminalTab): WorkspaceLayout {
  return {
    terminals: [...terminalsOf(layout).filter((t) => t.id !== terminal.id), terminal],
    mainOrder: [...allTabIds.filter((id) => id !== terminal.id), terminal.id],
    activeTerminalId: terminal.id,
  };
}

/** Drop a closed terminal from the layout (its tab, its place in the order, focus). */
export function withoutTerminal(layout: WorkspaceLayout | null | undefined, terminalId: string): WorkspaceLayout {
  const next: WorkspaceLayout = { ...layout, terminals: terminalsOf(layout).filter((t) => t.id !== terminalId) };
  if (next.mainOrder) next.mainOrder = next.mainOrder.filter((id) => id !== terminalId);
  if (next.activeTerminalId === terminalId) next.activeTerminalId = null;
  return next;
}
