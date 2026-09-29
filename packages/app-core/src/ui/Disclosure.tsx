/**
 * Inline content disclosure: a leading chevron + label header that shows/hides its children.
 *
 *   <Disclosure label="Details" actions={<IconButton …/>} defaultOpen>…</Disclosure>
 *
 * Sidebar sections use `SidebarGroup` (ui/Sidebar.tsx) instead.
 */
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronRight } from "lucide-preact";
import { cn } from "@glade/app-core/lib/cn";

export interface DisclosureProps {
  label: ComponentChildren;
  children: ComponentChildren;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Extra controls on the right of the header. */
  actions?: ComponentChildren;
  class?: string;
  headerClass?: string;
}

export function Disclosure({
  label,
  children,
  open: openProp,
  defaultOpen = true,
  onOpenChange,
  actions,
  class: className,
  headerClass,
}: DisclosureProps) {
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const setOpen = (o: boolean) => {
    setOpenState(o);
    onOpenChange?.(o);
  };
  const chevron = (
    <ChevronRight size={12} strokeWidth={2.5} class={cn("shrink-0 transition-transform duration-150", open && "rotate-90")} />
  );

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} class={className}>
      <div class={cn("flex items-center", headerClass)}>
        <Collapsible.Trigger
          class="flex h-6 min-w-0 flex-1 items-center gap-1 rounded-[5px] px-1 text-left text-fg-muted outline-none hover:text-fg"
        >
          {chevron}
          <span class="min-w-0 flex-1 truncate">{label}</span>
        </Collapsible.Trigger>
        {actions && <div class="flex items-center">{actions}</div>}
      </div>
      <Collapsible.Content>{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}
