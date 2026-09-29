/**
 * macOS-style dropdown menu built on Radix DropdownMenu.
 *
 *   <Menu trigger={<Button>Open</Button>}>
 *     <MenuItem onSelect={...}>Rename</MenuItem>
 *     <MenuSeparator />
 *     <MenuItem destructive onSelect={...}>Delete</MenuItem>
 *   </Menu>
 *
 * The item components also work inside <ContextMenu> (they pick the right Radix primitive from
 * context), so one list of items can back both a "…" button and a right-click menu.
 */
import type { ComponentChildren } from "preact";
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import * as DM from "@radix-ui/react-dropdown-menu";
import * as CM from "@radix-ui/react-context-menu";
import { Check, ChevronRight } from "lucide-preact";
import { cn } from "@glade/app-core/lib/cn";
import { floatingSurfaceClass } from "./floating";

export const menuContentClass =
  "z-50 min-w-[180px] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto rounded-[8px] p-[5px] text-[1rem] select-none outline-none " +
  floatingSurfaceClass;
export const menuItemClass =
  "relative flex h-[22px] items-center gap-2 rounded-[4px] px-2 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-fg data-[disabled]:opacity-40";

/** Which Radix menu family the items are rendered in. */
export const MenuKindContext = createContext<"dropdown" | "context">("dropdown");

function usePrimitives() {
  return useContext(MenuKindContext) === "context"
    ? { Item: CM.Item, Separator: CM.Separator, Label: CM.Label, Sub: CM.Sub, SubTrigger: CM.SubTrigger, SubContent: CM.SubContent, Portal: CM.Portal }
    : { Item: DM.Item, Separator: DM.Separator, Label: DM.Label, Sub: DM.Sub, SubTrigger: DM.SubTrigger, SubContent: DM.SubContent, Portal: DM.Portal };
}

export interface MenuProps {
  trigger: ComponentChildren;
  children: ComponentChildren;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  contentClass?: string;
  /** Call `e.preventDefault()` to stop focus returning to the trigger on close. */
  onCloseAutoFocus?: (e: Event) => void;
}

export function Menu({ trigger, children, align = "start", side = "bottom", open, onOpenChange, contentClass, onCloseAutoFocus }: MenuProps) {
  return (
    <DM.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content onCloseAutoFocus={onCloseAutoFocus} align={align} side={side} sideOffset={4} collisionPadding={8} class={cn(menuContentClass, contentClass)}>
          <MenuKindContext.Provider value="dropdown">{children}</MenuKindContext.Provider>
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
  const { Item } = usePrimitives();
  return (
    <Item
      onSelect={onSelect}
      disabled={disabled}
      class={cn(menuItemClass, destructive && "text-danger data-[highlighted]:bg-danger data-[highlighted]:text-white")}
    >
      {icon && <span class="flex w-4 justify-center [&_svg]:size-3.5">{icon}</span>}
      <span class="flex-1 truncate">{children}</span>
      {shortcut && <span class="ml-4 opacity-50">{shortcut}</span>}
    </Item>
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
  const { Item } = usePrimitives();
  return (
    <Item onSelect={onSelect} disabled={disabled} class={cn(menuItemClass, "pl-1")} aria-checked={checked} role="menuitemradio">
      <span class="flex w-4 justify-center">{checked && <Check size={12} strokeWidth={3} />}</span>
      <span class="flex-1 truncate">{children}</span>
      {detail && <span class="ml-4 text-[0.85rem] opacity-60">{detail}</span>}
    </Item>
  );
}

export function MenuSeparator() {
  const { Separator } = usePrimitives();
  return <Separator class="mx-2 my-[5px] h-px bg-separator" />;
}

export function MenuLabel({ children }: { children: ComponentChildren }) {
  const { Label } = usePrimitives();
  return <Label class="px-2 pt-1 pb-0.5 text-[0.85rem] font-semibold text-fg-muted">{children}</Label>;
}

/** A submenu (macOS: an item with a chevron that opens its items beside it), e.g. "Move to Folder". */
export function MenuSub({ label, disabled, children }: { label: ComponentChildren; disabled?: boolean; children: ComponentChildren }) {
  const { Sub, SubTrigger, SubContent, Portal } = usePrimitives();
  return (
    <Sub>
      <SubTrigger disabled={disabled} class={cn(menuItemClass, "data-[state=open]:bg-hover")}>
        <span class="flex-1 truncate">{label}</span>
        <ChevronRight size={12} class="-mr-1 opacity-60" aria-hidden />
      </SubTrigger>
      <Portal>
        <SubContent sideOffset={4} alignOffset={-5} collisionPadding={8} class={menuContentClass}>
          {children}
        </SubContent>
      </Portal>
    </Sub>
  );
}

export { DM as MenuPrimitive };
