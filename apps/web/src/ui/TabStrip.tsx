/**
 * Native-looking tab strip (a row of document tabs, like Safari/Finder window tabs) for a tab
 * group: status glyph + title + close button per tab, trailing actions (e.g. "+").
 *
 *   <TabStrip label="Conversations" tabs={[{ id, title, status }]} activeId={id}
 *     onSelect={focus} onClose={close} onTabDoubleClick={maximize}
 *     renamingId={renaming} onRenameDone={(id, title) => …}
 *     actions={<IconButton label="New Tab">…</IconButton>} />
 *
 * Keyboard (WAI-ARIA tabs, automatic activation): ←/→ Home/End move between tabs. Middle-click
 * closes a closable tab. `contextMenu` (MenuItems) opens on right click.
 */
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { ChatStatus } from "@pi-ui/protocol";
import { X } from "lucide-preact";
import { cn } from "@/lib/cn";
import { ContextMenu } from "./ContextMenu";
import { StatusIndicator } from "./StatusIndicator";

export const TAB_STRIP_HEIGHT = 30;

export interface TabStripTab {
  id: string;
  title: string;
  status: ChatStatus;
  failed?: boolean;
  /** Shows the close button (default true). */
  closable?: boolean;
  /** Right-click menu items. */
  contextMenu?: ComponentChildren;
}

export interface TabStripProps {
  /** Accessible name of the tab list. */
  label: string;
  tabs: readonly TabStripTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
  onTabDoubleClick?: (id: string) => void;
  /** Tab whose title is being edited inline. */
  renamingId?: string | null;
  /** Inline rename finished: the new title, or `null` when cancelled/unchanged. */
  onRenameDone?: (id: string, title: string | null) => void;
  /** id of the tab panel element (aria-controls of the active tab). */
  panelId?: string;
  /** Trailing controls after the tabs (e.g. a "+" button). */
  actions?: ComponentChildren;
  class?: string;
}

export function TabStrip({
  label,
  tabs,
  activeId,
  onSelect,
  onClose,
  onTabDoubleClick,
  renamingId,
  onRenameDone,
  panelId,
  actions,
  class: className,
}: TabStripProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the active tab scrolled into view (the list scrolls horizontally when crowded).
  useEffect(() => {
    const list = listRef.current;
    const tab = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !tab) return;
    if (tab.offsetLeft < list.scrollLeft) list.scrollLeft = tab.offsetLeft;
    else if (tab.offsetLeft + tab.offsetWidth > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = tab.offsetLeft + tab.offsetWidth - list.clientWidth;
    }
  }, [activeId, tabs.length]);

  const move = (from: string, to: number) => {
    const target = tabs[(to + tabs.length) % tabs.length];
    if (!target || target.id === from) return;
    onSelect(target.id);
    listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(target.id)}"]`)?.focus();
  };

  return (
    <div
      style={{ height: `${TAB_STRIP_HEIGHT}px` }}
      class={cn("flex shrink-0 items-stretch border-b-[0.5px] border-separator bg-tabbar", className)}
    >
      <div
        ref={listRef}
        role="tablist"
        aria-label={label}
        class="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
      >
        {tabs.map((tab, index) => {
          const active = tab.id === activeId;
          const closable = tab.closable !== false && !!onClose;
          const renaming = renamingId === tab.id;
          const el = (
            <div
              key={tab.id}
              role="tab"
              data-tab-id={tab.id}
              aria-selected={active}
              aria-controls={active ? panelId : undefined}
              tabIndex={active ? 0 : -1}
              title={tab.title}
              onMouseDown={(e) => {
                // Middle click closes (and must not start autoscroll).
                if (e.button === 1) e.preventDefault();
              }}
              onClick={() => !renaming && onSelect(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1 && closable) onClose?.(tab.id);
              }}
              onDblClick={(e) => {
                if (renaming || (e.target as HTMLElement).closest("button")) return;
                onTabDoubleClick?.(tab.id);
              }}
              onKeyDown={(e) => {
                if (renaming) return;
                if (e.key === "ArrowRight") (e.preventDefault(), move(tab.id, index + 1));
                else if (e.key === "ArrowLeft") (e.preventDefault(), move(tab.id, index - 1));
                else if (e.key === "Home") (e.preventDefault(), move(tab.id, 0));
                else if (e.key === "End") (e.preventDefault(), move(tab.id, tabs.length - 1));
              }}
              class={cn(
                "group/tab relative flex max-w-[220px] min-w-[96px] shrink-0 basis-[180px] items-center gap-1.5 border-r-[0.5px] border-separator pr-1 pl-2 text-[0.92rem] outline-none",
                "focus-visible:shadow-[inset_0_0_0_2px_color-mix(in_srgb,var(--pi-accent)_45%,transparent)]",
                active ? "bg-window text-fg -mb-[0.5px]" : "text-fg-muted hover:bg-hover",
              )}
            >
              <StatusIndicator status={tab.status} failed={tab.failed} size={12} tooltip={false} />
              {renaming ? (
                <TabRenameInput value={tab.title} onDone={(title) => onRenameDone?.(tab.id, title)} />
              ) : (
                <span class={cn("min-w-0 flex-1 truncate", active && "font-medium")}>{tab.title}</span>
              )}
              {closable && !renaming && (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={`Close ${tab.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose?.(tab.id);
                  }}
                  class={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-[4px] text-fg-muted hover:bg-selected hover:text-fg [&_svg]:size-3",
                    active ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100",
                  )}
                >
                  <X />
                </button>
              )}
            </div>
          );
          return tab.contextMenu ? (
            <ContextMenu key={tab.id} content={tab.contextMenu}>
              {el}
            </ContextMenu>
          ) : (
            el
          );
        })}
      </div>
      {actions && <div class="flex shrink-0 items-center gap-0.5 px-1">{actions}</div>}
    </div>
  );
}

/** Inline title editor inside a tab: Enter/blur saves, Escape cancels. */
function TabRenameInput({ value, onDone }: { value: string; onDone: (value: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const next = ref.current?.value.trim() ?? "";
    onDone(save && next && next !== value ? next : null);
  };
  return (
    <input
      ref={ref}
      defaultValue={value}
      aria-label="Tab title"
      spellcheck={false}
      class="h-5 min-w-0 flex-1 rounded-[4px] bg-control px-1 text-fg outline-none shadow-[0_0_0_2px_color-mix(in_srgb,var(--pi-accent)_45%,transparent)]"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.preventDefault(), finish(true));
        if (e.key === "Escape") (e.preventDefault(), finish(false));
      }}
      onBlur={() => finish(true)}
    />
  );
}
