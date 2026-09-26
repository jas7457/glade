/**
 * Source-list row (Finder / Mail sidebar style): leading status slot, icon, label, trailing
 * indicators, and hover actions that replace the trailing indicators (the leading slot stays
 * visible). The single row primitive for every sidebar; metrics come from `sidebar-metrics.ts`.
 * The leading slot always sits in the sidebar's status column (flush with the group headers),
 * whatever the row's indent; the icon/label start at the indent. The row itself is a button; `actions` sit beside it so
 * nested buttons stay valid. Forwards ref + extra props to the outer element so it can be a
 * Radix ContextMenu trigger.
 */
import type { ComponentChildren, JSX } from "preact";
import { forwardRef } from "preact/compat";
import { cn } from "@/lib/cn";
import { sidebarClass, type SidebarIndent } from "./sidebar-metrics";

export interface SidebarItemProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "label" | "icon" | "onSelect"> {
  label: ComponentChildren;
  icon?: ComponentChildren;
  selected?: boolean;
  onSelect?: () => void;
  /**
   * Status slot (e.g. a chat status indicator), placed in the status column (column 0), left of
   * the indented icon/label. Stays visible on hover. Rows with a leading slot need indent ≥ 1
   * (the default when `leading` is passed) so the label clears the column.
   */
  leading?: ComponentChildren;
  /** Right-side status (spinner, unread dot, time…). Hidden while hovering if `actions` exist. */
  trailing?: ComponentChildren;
  /** Buttons shown on hover (and while `actionsVisible`). */
  actions?: ComponentChildren;
  /** Keep actions visible (e.g. while their menu is open). */
  actionsVisible?: boolean;
  /** Left padding level (see the grid in sidebar-metrics.ts). Default 0, or 1 with `leading`. */
  indent?: SidebarIndent;
  /** Emphasised label (unread). */
  strong?: boolean;
  /** Replaces the label button entirely (inline rename field). */
  editor?: ComponentChildren;
  title?: string;
}

export const SidebarItem = forwardRef<HTMLDivElement, SidebarItemProps>(function SidebarItem(
  { label, icon, leading, selected, onSelect, trailing, actions, actionsVisible, indent: indentProp, strong, editor, title, class: className, ...rest },
  ref,
) {
  const indent = indentProp ?? (leading !== undefined ? 1 : 0);
  const leadingSlot = leading !== undefined && (
    <span data-slot="leading" class={cn("flex items-center justify-center", sidebarClass.status)}>
      {leading}
    </span>
  );
  const iconSlot = icon && <span class={cn("flex w-4 shrink-0 justify-center [&_svg]:size-4", sidebarClass.fgMuted)}>{icon}</span>;
  return (
    <div
      ref={ref}
      data-selected={selected || undefined}
      class={cn(
        "group/item relative flex items-center",
        sidebarClass.row,
        "rounded-[6px] text-[1rem]",
        selected ? cn("bg-selected", sidebarClass.fgStrong) : cn("hover:bg-hover", sidebarClass.fg, sidebarClass.fgHover),
        "data-[state=open]:ring-2 data-[state=open]:ring-accent/60 data-[state=open]:ring-inset",
        className as string,
      )}
      {...rest}
    >
      {editor ? (
        <div class={cn("relative flex h-full min-w-0 flex-1 items-center gap-2 pr-1", sidebarClass.inset[indent])}>
          {leadingSlot}
          {iconSlot}
          {editor}
        </div>
      ) : (
        <button
          type="button"
          title={title}
          aria-current={selected ? "page" : undefined}
          onClick={onSelect}
          class={cn(
            "relative flex h-full min-w-0 flex-1 items-center gap-2 rounded-[6px] pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
            sidebarClass.inset[indent],
          )}
        >
          {leadingSlot}
          {iconSlot}
          <span class={cn("min-w-0 flex-1 truncate", strong && cn("font-semibold", sidebarClass.fgStrong))}>{label}</span>
          {trailing && (
            <span
              data-slot="trailing"
              class={cn(
                cn("flex shrink-0 items-center gap-1.5 text-[0.85rem] tabular-nums", sidebarClass.fgMuted),
                actions && "group-hover/item:invisible",
                actions && actionsVisible && "invisible",
              )}
            >
              {trailing}
            </span>
          )}
        </button>
      )}
      {actions && !editor && (
        <div
          class={cn(
            "absolute top-0 right-1 bottom-0 hidden items-center gap-0.5 group-hover/item:flex",
            actionsVisible && "flex",
          )}
        >
          {actions}
        </div>
      )}
    </div>
  );
});
