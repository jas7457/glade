/**
 * The chat list as an overlay over the current chat (I-164 step 5, doc §5.4): slides in from
 * the left (menu button or an edge swipe on the chat screen). Stub until step 5.
 */
export interface SidebarOverlayProps {
  open: boolean;
  onClose: () => void;
}

export function SidebarOverlay({ open }: SidebarOverlayProps) {
  if (!open) return null;
  return null;
}
