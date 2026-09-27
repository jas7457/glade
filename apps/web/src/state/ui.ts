/**
 * App-shell UI state that isn't server data: sidebar width/collapse (persisted in
 * localStorage), collapsed project groups, the "Add project" dialog and the command palette.
 */
import { effect, signal } from "@preact/signals";

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 260;
/** Dragging the handle narrower than this collapses the sidebar (like NSSplitView). */
export const SIDEBAR_COLLAPSE_THRESHOLD = 140;

/** Clamp a sidebar width to the allowed range (non-finite values fall back to the default). */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

/** Resolve a drag of the resize handle: new width, or collapse when dragged far enough left. */
export function resolveSidebarDrag(startWidth: number, deltaX: number): { width: number; collapsed: boolean } {
  const raw = startWidth + deltaX;
  if (raw < SIDEBAR_COLLAPSE_THRESHOLD) return { width: clampSidebarWidth(startWidth), collapsed: true };
  return { width: clampSidebarWidth(raw), collapsed: false };
}

const KEY_WIDTH = "glade.sidebar.width";
const KEY_COLLAPSED = "glade.sidebar.collapsed";
const KEY_CLOSED_PROJECTS = "glade.sidebar.closedProjects";
/** Key prefixes before the rename (I-059): read once when the new key is missing. */
const KEY_PREFIX = "glade.";
const LEGACY_KEY_PREFIX = "pi-ui.";

/** Reads a stored value, falling back to its pre-rename `pi-ui.*` key (the next write moves it). */
export function readStored(key: string): string | null {
  try {
    const value = localStorage.getItem(key);
    if (value !== null || !key.startsWith(KEY_PREFIX)) return value;
    return localStorage.getItem(LEGACY_KEY_PREFIX + key.slice(KEY_PREFIX.length));
  } catch {
    return null;
  }
}
const read = readStored;
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

export const sidebarWidth = signal(clampSidebarWidth(Number(read(KEY_WIDTH) ?? SIDEBAR_DEFAULT_WIDTH)));
export const sidebarCollapsed = signal(read(KEY_COLLAPSED) === "1");
/** Project ids whose chat list is collapsed in the sidebar. */
export const closedProjects = signal<ReadonlySet<string>>(new Set(JSON.parse(read(KEY_CLOSED_PROJECTS) ?? "[]") as string[]));

effect(() => write(KEY_WIDTH, String(sidebarWidth.value)));
effect(() => write(KEY_COLLAPSED, sidebarCollapsed.value ? "1" : "0"));
effect(() => write(KEY_CLOSED_PROJECTS, JSON.stringify([...closedProjects.value])));

export function toggleSidebar(): void {
  sidebarCollapsed.value = !sidebarCollapsed.value;
}

export function setProjectOpen(projectId: string, open: boolean): void {
  const next = new Set(closedProjects.value);
  if (open) next.delete(projectId);
  else next.add(projectId);
  closedProjects.value = next;
}

/** Whether the "Add project" dialog is showing. */
export const addProjectOpen = signal(false);
export function openAddProject(): void {
  addProjectOpen.value = true;
}

/** Whether the command palette (⌘K) is showing. */
export const paletteOpen = signal(false);
export function togglePalette(): void {
  paletteOpen.value = !paletteOpen.value;
}
