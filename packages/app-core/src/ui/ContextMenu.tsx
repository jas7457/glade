/**
 * Right-click menu (Radix ContextMenu) with the same look as <Menu>. Use the regular
 * MenuItem / MenuCheckItem / MenuSeparator / MenuLabel components as its items.
 *
 *   <ContextMenu content={<><MenuItem onSelect={rename}>Rename</MenuItem></>}>
 *     <div>row</div>
 *   </ContextMenu>
 */
import type { ComponentChildren } from "preact";
import * as CM from "@radix-ui/react-context-menu";
import { cn } from "@glade/app-core/lib/cn";
import { MenuKindContext, menuContentClass } from "./Menu";

export interface ContextMenuProps {
  /** Menu items. */
  content: ComponentChildren;
  /** The element that opens the menu on right click (rendered as-is via asChild). */
  children: ComponentChildren;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  contentClass?: string;
  /** Call `e.preventDefault()` to stop focus returning to the trigger on close. */
  onCloseAutoFocus?: (e: Event) => void;
}

export function ContextMenu({ content, children, disabled, onOpenChange, contentClass, onCloseAutoFocus }: ContextMenuProps) {
  return (
    <CM.Root onOpenChange={onOpenChange} modal={false}>
      <CM.Trigger asChild disabled={disabled}>
        {children}
      </CM.Trigger>
      <CM.Portal>
        <CM.Content
          onCloseAutoFocus={onCloseAutoFocus}
          collisionPadding={8}
          class={cn(menuContentClass, "max-h-[var(--radix-context-menu-content-available-height)]", contentClass)}
        >
          <MenuKindContext.Provider value="context">{content}</MenuKindContext.Provider>
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}
