/**
 * Source-list row (Finder / Mail sidebar style): icon, label, trailing indicators, and hover
 * actions that replace the indicators. The row itself is a button; `actions` sit beside it so
 * nested buttons stay valid. Forwards ref + extra props to the outer element so it can be a
 * Radix ContextMenu trigger.
 */
import type { ComponentChildren, JSX } from "preact";
import { forwardRef } from "preact/compat";
import { cn } from "@/lib/cn";

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
  /** Left padding level (each level ≈ one icon width). */
  indent?: 0 | 1;
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
  return (
    <div
      ref={ref}
      data-selected={selected || undefined}
      class={cn(
        "group/item relative flex h-7 items-center rounded-[6px] text-[1rem] text-fg",
        selected ? "bg-selected" : "hover:bg-hover",
        "data-[state=open]:ring-2 data-[state=open]:ring-accent/60 data-[state=open]:ring-inset",
        className as string,
      )}
      {...rest}
    >
      {editor ? (
        <div class={cn("flex min-w-0 flex-1 items-center gap-2 pr-1", indent ? "pl-7" : "pl-2")}>
          {icon && <span class="flex w-4 shrink-0 justify-center text-fg-muted [&_svg]:size-4">{icon}</span>}
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
            indent ? "pl-7" : "pl-2",
          )}
        >
          {icon && <span class="flex w-4 shrink-0 justify-center text-fg-muted [&_svg]:size-4">{icon}</span>}
          <span class={cn("min-w-0 flex-1 truncate", strong && "font-semibold")}>{label}</span>
          {trailing && (
            <span
              class={cn(
                "flex shrink-0 items-center gap-1.5 text-[0.85rem] text-fg-subtle tabular-nums",
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
