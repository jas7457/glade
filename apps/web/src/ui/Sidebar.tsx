/**
 * Sidebar building blocks shared by the app sidebar and the settings sidebar:
 *
 *   <SidebarGroup title="Projects" collapsible actions={<IconButton …/>}>
 *     <SidebarList>{rows as <SidebarItem/>}</SidebarList>
 *   </SidebarGroup>
 *
 * A titled group has the standard group gap above it and a small muted header, so headers
 * visibly belong to the rows below them. Untitled groups (e.g. "Back to App") add no gap.
 * Collapsible groups (Projects/Chats) toggle from the header; static ones (settings
 * categories) don't. All spacing comes from `sidebar-metrics.ts`.
 */
import type { ComponentChildren } from "preact";
import { useId, useState } from "preact/hooks";
import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronRight } from "lucide-preact";
import { cn } from "@/lib/cn";
import { sidebarClass } from "./sidebar-metrics";

export interface SidebarListProps {
  children: ComponentChildren;
  role?: "list";
  class?: string;
}

/** Vertical stack of sidebar rows with the standard row gap. */
export function SidebarList({ children, role, class: className }: SidebarListProps) {
  return (
    <div role={role} class={cn(sidebarClass.rows, className)}>
      {children}
    </div>
  );
}

export interface SidebarGroupProps {
  /** Header label. Without a title the group is just a spaced block of rows. */
  title?: string;
  /** Header toggles the content (chevron on hover). */
  collapsible?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Controls on the right of the header (e.g. "Add Project"). */
  actions?: ComponentChildren;
  children: ComponentChildren;
  class?: string;
}

const headerLabelClass = "min-w-0 flex-1 truncate text-[0.85rem] font-semibold text-fg-subtle";

export function SidebarGroup({
  title,
  collapsible = false,
  open: openProp,
  defaultOpen = true,
  onOpenChange,
  actions,
  children,
  class: className,
}: SidebarGroupProps) {
  const [openState, setOpenState] = useState(defaultOpen);
  const headerId = useId();
  const open = collapsible ? (openProp ?? openState) : true;
  const setOpen = (o: boolean) => {
    setOpenState(o);
    onOpenChange?.(o);
  };

  const rootClass = cn(title && sidebarClass.groupGap, className);
  if (!title) return <div class={rootClass}>{children}</div>;

  const header = (label: ComponentChildren) => (
    <div class={cn("group/header flex items-center", sidebarClass.header)}>
      {label}
      {actions && <div class="flex items-center">{actions}</div>}
    </div>
  );

  if (!collapsible) {
    return (
      <div role="group" aria-labelledby={headerId} class={rootClass}>
        {header(
          <div id={headerId} class={cn("flex h-full items-center px-2", headerLabelClass)}>
            {title}
          </div>,
        )}
        {children}
      </div>
    );
  }

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} class={rootClass}>
      {header(
        <Collapsible.Trigger
          id={headerId}
          class={cn("flex h-full items-center gap-1 rounded-[5px] px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/50", headerLabelClass)}
        >
          <span class="min-w-0 flex-1 truncate">{title}</span>
          <span class="opacity-0 group-hover/header:opacity-100">
            <ChevronRight size={12} strokeWidth={2.5} class={cn("shrink-0 transition-transform duration-150", open && "rotate-90")} />
          </span>
        </Collapsible.Trigger>,
      )}
      <Collapsible.Content>{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}
