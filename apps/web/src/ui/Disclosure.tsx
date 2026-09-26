/**
 * Collapsible section: a chevron + label header that shows/hides its children.
 *
 *   <Disclosure label="Projects" actions={<IconButton …/>} defaultOpen>…</Disclosure>
 *
 * `variant="section"` is the Finder-sidebar style (small muted header, chevron on hover);
 * `variant="inline"` has a leading chevron (content disclosure, e.g. "Details").
 */
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronRight } from "lucide-preact";
import { cn } from "@/lib/cn";

export interface DisclosureProps {
  label: ComponentChildren;
  children: ComponentChildren;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Extra controls on the right of the header (shown on hover for `section`). */
  actions?: ComponentChildren;
  variant?: "section" | "inline";
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
  variant = "inline",
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
      <div class={cn("group/disclosure flex items-center", headerClass)}>
        <Collapsible.Trigger
          class={cn(
            "flex min-w-0 flex-1 items-center gap-1 rounded-[5px] text-left outline-none",
            variant === "section"
              ? "h-6 px-2 text-[0.85rem] font-semibold text-fg-subtle"
              : "h-6 px-1 text-fg-muted hover:text-fg",
          )}
        >
          {variant === "inline" && chevron}
          <span class="min-w-0 flex-1 truncate">{label}</span>
          {variant === "section" && <span class="opacity-0 group-hover/disclosure:opacity-100">{chevron}</span>}
        </Collapsible.Trigger>
        {actions && <div class="flex items-center">{actions}</div>}
      </div>
      <Collapsible.Content>{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}
