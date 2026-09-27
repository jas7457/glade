/**
 * UI kit barrel. Features import primitives from "@/ui".
 */
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from "./Button";
export { IconButton, type IconButtonProps } from "./IconButton";
export { Tooltip, TooltipProvider, type TooltipProps } from "./Tooltip";
export { floatingSurfaceClass } from "./floating";
export {
  Menu,
  MenuItem,
  MenuCheckItem,
  MenuSeparator,
  MenuLabel,
  MenuPrimitive,
  menuContentClass,
  menuItemClass,
  type MenuProps,
  type MenuItemProps,
  type MenuCheckItemProps,
} from "./Menu";
export { ContextMenu, type ContextMenuProps } from "./ContextMenu";
export { Spinner } from "./Spinner";
export { Dialog, DialogClose, DialogIcon, dialogClass, type DialogProps, type DialogTone } from "./Dialog";
export { AlertDialog, ConfirmHost, confirm, shortenSubject, type AlertDialogProps, type ConfirmOptions } from "./AlertDialog";
export { TextField, TextArea, fieldClass, type TextFieldProps, type TextAreaProps } from "./TextField";
export { Switch, SwitchField, type SwitchProps, type SwitchFieldProps } from "./Switch";
export { SegmentedControl, type SegmentedControlProps, type SegmentOption } from "./SegmentedControl";
export { Select, type SelectProps, type SelectOption } from "./Select";
export { Disclosure, type DisclosureProps } from "./Disclosure";
export { Kbd, formatShortcut } from "./Kbd";
export { Toaster } from "./Toaster";
export { SidebarItem, type SidebarItemProps } from "./SidebarItem";
export { SidebarGroup, SidebarList, type SidebarGroupProps, type SidebarListProps } from "./Sidebar";
export { SIDEBAR_METRICS, sidebarClass, type SidebarIndent } from "./sidebar-metrics";
export { StatusIndicator, statusLabel, type StatusIndicatorProps } from "./StatusIndicator";
export { FormGroup, FormRow, type FormGroupProps, type FormRowProps } from "./Form";
export { Titlebar, TITLEBAR_HEIGHT, TRAFFIC_LIGHTS_WIDTH } from "./Titlebar";
export { SearchPopover, matchesQuery, type SearchPopoverProps, type SearchPopoverItem, type SearchPopoverSection } from "./SearchPopover";
export { CommandPalette, type CommandPaletteProps, type CommandPaletteItem, type CommandPaletteSection } from "./CommandPalette";
export { TabStrip, TAB_STRIP_HEIGHT, type TabStripProps, type TabStripTab } from "./TabStrip";
export { SplitView, type SplitViewProps } from "./SplitView";
export { TextHighlight } from "./TextHighlight";
export { Chip, type ChipProps } from "./Chip";
export { Checkbox, type CheckboxProps } from "./Checkbox";
export { Badge, type BadgeProps } from "./Badge";
export { ToolbarToggle, type ToolbarToggleProps } from "./ToolbarToggle";
export { Clamp, type ClampProps } from "./Clamp";
export { Lightbox, canCopyImages, copyImageToClipboard, type LightboxProps, type LightboxImage } from "./Lightbox";
