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
 *   8   Projects                          +   ← group header text
 *   8   📁 32 piui-demo                        ← project rows: icon at indent 0, name at 32
 *            32 Chat in project          ●    ← project chats: title at indent 1 (= project name)
 *   8   Chats
 *   8   Standalone chat                 34m   ← standalone chats: title at indent 0
 *
 * Indent 0 is flush with the header text; indent 1 is one icon (16px) + gap (8px) further right,
 * i.e. where a label starts after an icon. Status / age / pin sit on the right of the row
 * (the trailing slot) and hover actions replace them. The settings sidebar uses indent 0.
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
  /** Width of row icons. */
  iconWidth: 16,
  /** Gap between a row icon and its label. */
  iconGap: 8,
  /** Row content (icon, else label) start per indent level: 8 (= header text) + n × (16 + 8). */
  inset: [8, 32],
} as const;

export const sidebarClass = {
  row: "h-[30px]",
  rows: "flex flex-col gap-0.5",
  groupGap: "mt-4",
  header: "h-6 mb-0.5",
  subgroupGap: "mb-1.5",
  paddingX: "px-2.5",
  inset: ["pl-2", "pl-8"],
  /** Left edge of full-width lines (drop line, pinned divider) aligned with the content per indent. */
  lineStart: ["left-2", "left-8"],
  /** Text colours (tokens in styles.css): row labels, selected/unread rows, headers + ages + icons. */
  fg: "text-sidebar-fg",
  fgStrong: "text-sidebar-fg-strong",
  fgMuted: "text-sidebar-fg-muted",
  /** Rows brighten slightly on hover. */
  fgHover: "hover:text-sidebar-fg-strong",
} as const;

export type SidebarIndent = 0 | 1;
