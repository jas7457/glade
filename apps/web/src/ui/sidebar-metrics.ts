/**
 * Sidebar spacing metrics, defined once and shared by every sidebar primitive (SidebarItem,
 * SidebarList, SidebarGroup) so the app sidebar and the settings sidebar line up exactly.
 *
 * `SIDEBAR_METRICS` documents the values in px; `sidebarClass` holds the matching Tailwind
 * classes (literal strings so Tailwind picks them up). Change both together. It also names the
 * sidebar text-colour classes so every sidebar row uses the same `--pi-sidebar-fg*` tokens.
 *
 * Horizontal grid (x from the content edge, i.e. inside `paddingX`):
 *
 *   8   Projects                        ← group header text
 *   8   ●  32 📁 56 piui-demo            ← status column; project icon at indent 1, name at 56
 *   8   ●         56 Chat in project     ← project chats: title at indent 2 (= project name)
 *   8   Chats
 *   8   ●  32 Standalone chat            ← standalone chats: title at indent 1
 *
 * Column 0 (`status`) is flush with the header text; every indent level is one status column
 * (16px) + gap (8px) further right. Rows without a status (New Chat, settings) use indent 0.
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
  /** Left edge of the status column (column 0); equals the group header text inset. */
  statusInset: 8,
  /** Width of the status column (and of row icons). */
  statusWidth: 16,
  /** Row content (icon, else label) start per indent level: statusInset + n × (16 + 8). */
  inset: [8, 32, 56],
  /** Where row labels start after an icon, per indent level (inset + 16px icon + 8px gap). */
  labelInset: [32, 56, 80],
} as const;

export const sidebarClass = {
  row: "h-[30px]",
  rows: "flex flex-col gap-0.5",
  groupGap: "mt-4",
  header: "h-6 mb-0.5",
  subgroupGap: "mb-1.5",
  paddingX: "px-2.5",
  /** Status column: absolutely placed at `statusInset`, `statusWidth` wide, vertically centred. */
  status: "absolute top-0 bottom-0 left-2 w-4",
  inset: ["pl-2", "pl-8", "pl-14"],
  labelInset: ["pl-8", "pl-14", "pl-20"],
  /** Left edge of full-width lines (drop line, pinned divider) aligned with the content per indent. */
  lineStart: ["left-2", "left-8", "left-14"],
  /** Text colours (tokens in styles.css): row labels, selected/unread rows, headers + ages + icons. */
  fg: "text-sidebar-fg",
  fgStrong: "text-sidebar-fg-strong",
  fgMuted: "text-sidebar-fg-muted",
  /** Rows brighten slightly on hover. */
  fgHover: "hover:text-sidebar-fg-strong",
} as const;

export type SidebarIndent = 0 | 1 | 2;
