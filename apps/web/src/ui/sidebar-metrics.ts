/**
 * Sidebar spacing metrics, defined once and shared by every sidebar primitive (SidebarItem,
 * SidebarList, SidebarGroup) so the app sidebar and the settings sidebar line up exactly.
 *
 * `SIDEBAR_METRICS` documents the values in px; `sidebarClass` holds the matching Tailwind
 * classes (literal strings so Tailwind picks them up). Change both together. It also names the
 * sidebar text-colour classes so every sidebar row uses the same `--pi-sidebar-fg*` tokens.
 */

export const SIDEBAR_METRICS = {
  /** Height of one row. */
  rowHeight: 30,
  /** Vertical gap between consecutive rows. */
  rowGap: 2,
  /** Space above a titled group (separates top actions / Projects / Chats, settings categories). */
  groupGap: 16,
  /** Height of a group header; its label sits closer to its rows than to the group above. */
  headerHeight: 24,
  /** Space between a group header and its first row. */
  headerGapBelow: 2,
  /** Extra space after an expanded nested group (a project and its chats). */
  subgroupGap: 6,
  /** Horizontal padding of the sidebar content. */
  paddingX: 10,
  /** Row left padding per indent level. */
  inset: [8, 20],
  /** Where row labels start per indent level (inset + 16px icon column + 8px gap). */
  labelInset: [32, 44],
} as const;

export const sidebarClass = {
  row: "h-[30px]",
  rows: "flex flex-col gap-0.5",
  groupGap: "mt-4",
  header: "h-6 mb-0.5",
  subgroupGap: "mb-1.5",
  paddingX: "px-2.5",
  inset: ["pl-2", "pl-5"],
  labelInset: ["pl-8", "pl-11"],
  /** Text colours (tokens in styles.css): row labels, selected/unread rows, headers + ages + icons. */
  fg: "text-sidebar-fg",
  fgStrong: "text-sidebar-fg-strong",
  fgMuted: "text-sidebar-fg-muted",
  /** Rows brighten slightly on hover. */
  fgHover: "hover:text-sidebar-fg-strong",
} as const;

export type SidebarIndent = 0 | 1;
