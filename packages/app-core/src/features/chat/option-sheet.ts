/**
 * Pickers and small menus as bottom sheets (I-164, the iPhone app): a shell that wants the
 * composer's model / thinking / agent pickers (and the Send button's options) as sheets instead
 * of popover menus provides a sheet component here. Absent (the desktop and the web), the
 * components keep their popover menus.
 *
 *   <OptionSheetContext.Provider value={MySheetList}> … <Composer chatId={…} /> …
 */
import type { ComponentChildren, ComponentType } from "preact";
import { createContext } from "preact";
import { useContext } from "preact/hooks";

export interface OptionSheetItem {
  key: string;
  label: ComponentChildren;
  /** Secondary text on the right (e.g. "default"). */
  detail?: ComponentChildren;
  /** A checkmark (pickers); undefined = a plain action row. */
  checked?: boolean;
  icon?: ComponentChildren;
  /** Longer explanation under the label. */
  description?: ComponentChildren;
  disabled?: boolean;
  onSelect: () => void;
}

export interface OptionSheetSection {
  title?: string;
  items: OptionSheetItem[];
}

export interface OptionSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  sections: OptionSheetSection[];
}

export const OptionSheetContext = createContext<ComponentType<OptionSheetProps> | null>(null);

/** The sheet component to use instead of a popover menu, or null (keep the menu). */
export function useOptionSheet(): ComponentType<OptionSheetProps> | null {
  return useContext(OptionSheetContext);
}
