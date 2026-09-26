/**
 * Source-list row (Finder / Mail sidebar style): icon, label, trailing indicators (status, age,
 * pin…), and hover actions that replace the trailing indicators. The single row primitive for
 * every sidebar; metrics come from `sidebar-metrics.ts` (the icon/label start at the row's
 * indent). The row itself is a button; `actions` sit beside it so nested buttons stay valid. Forwards ref + extra props to the outer element so it can be a
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
  /** Right-side status (spinner, unread dot, time…). Hidden while hovering if `actions` exist. */
  trailing?: ComponentChildren;
  /** Buttons shown on hover (and while `actionsVisible`). */
  actions?: ComponentChildren;
  /** Keep actions visible (e.g. while their menu is open). */
  actionsVisible?: boolean;
  /** Left padding level (see the grid in sidebar-metrics.ts). Default 0. */
  indent?: SidebarIndent;
  /** Emphasised label (unread). */
  strong?: boolean;
  /** Replaces the label button entirely (inline rename field). */
  editor?: ComponentChildren;
  title?: string;
}

export const SidebarItem = forwardRef<HTMLDivElement, SidebarItemProps>(function SidebarItem(
  { label, icon, selected, onSelect, trailing, actions, actionsVisible, indent = 0, strong, editor, title, class: className, ...rest },
  ref,
) {
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
        <div class={cn("flex h-full min-w-0 flex-1 items-center gap-2 pr-1", sidebarClass.inset[indent])}>
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
            "flex h-full min-w-0 flex-1 items-center gap-2 rounded-[6px] pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
            sidebarClass.inset[indent],
          )}
        >
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
