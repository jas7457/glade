/**
 * macOS-style dropdown menu built on Radix DropdownMenu.
 *
 *   <Menu trigger={<Button>Open</Button>}>
 *     <MenuItem onSelect={...}>Rename</MenuItem>
 *     <MenuSeparator />
 *     <MenuItem destructive onSelect={...}>Delete</MenuItem>
 *   </Menu>
 */
import type { ComponentChildren } from "preact";
import * as DM from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-preact";
import { cn } from "@/lib/cn";

export const menuContentClass =
  "z-50 min-w-[180px] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto rounded-[8px] bg-surface-raised/95 backdrop-blur-xl p-[5px] text-[1rem] text-fg shadow-popover select-none outline-none";
export const menuItemClass =
  "relative flex h-[22px] items-center gap-2 rounded-[4px] px-2 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-fg data-[disabled]:opacity-40";

export interface MenuProps {
  trigger: ComponentChildren;
  children: ComponentChildren;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  contentClass?: string;
}

export function Menu({ trigger, children, align = "start", side = "bottom", open, onOpenChange, contentClass }: MenuProps) {
  return (
    <DM.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content align={align} side={side} sideOffset={4} collisionPadding={8} class={cn(menuContentClass, contentClass)}>
          {children}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

export interface MenuItemProps {
  onSelect?: (event: Event) => void;
  disabled?: boolean;
  destructive?: boolean;
  icon?: ComponentChildren;
  shortcut?: string;
  children: ComponentChildren;
}

export function MenuItem({ onSelect, disabled, destructive, icon, shortcut, children }: MenuItemProps) {
  return (
    <DM.Item
      onSelect={onSelect}
      disabled={disabled}
      class={cn(menuItemClass, destructive && "text-danger data-[highlighted]:bg-danger data-[highlighted]:text-white")}
    >
      {icon && <span class="flex w-4 justify-center [&_svg]:size-3.5">{icon}</span>}
      <span class="flex-1 truncate">{children}</span>
      {shortcut && <span class="ml-4 text-fg-subtle">{shortcut}</span>}
    </DM.Item>
  );
}

export interface MenuCheckItemProps {
  checked: boolean;
  onSelect?: (event: Event) => void;
  disabled?: boolean;
  /** Secondary text, right aligned. */
  detail?: ComponentChildren;
  children: ComponentChildren;
}

/** Item with a leading checkmark (used for single-choice lists like model pickers). */
export function MenuCheckItem({ checked, onSelect, disabled, detail, children }: MenuCheckItemProps) {
  return (
    <DM.Item onSelect={onSelect} disabled={disabled} class={cn(menuItemClass, "pl-1")}>
      <span class="flex w-4 justify-center">{checked && <Check size={12} strokeWidth={3} />}</span>
      <span class="flex-1 truncate">{children}</span>
      {detail && <span class="ml-4 text-[0.85rem] opacity-60">{detail}</span>}
    </DM.Item>
  );
}

export function MenuSeparator() {
  return <DM.Separator class="mx-2 my-[5px] h-px bg-separator" />;
}

export function MenuLabel({ children }: { children: ComponentChildren }) {
  return <DM.Label class="px-2 pt-1 pb-0.5 text-[0.85rem] font-semibold text-fg-muted">{children}</DM.Label>;
}

export { DM as MenuPrimitive };
