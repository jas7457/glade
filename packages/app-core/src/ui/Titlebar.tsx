/**
 * Window titlebar strip: a drag region (Tauri `data-tauri-drag-region`) tall enough for the
 * macOS traffic lights. `inset` leaves room for the traffic lights on the left.
 */
import type { ComponentChildren } from "preact";
import { cn } from "@glade/app-core/lib/cn";

export const TITLEBAR_HEIGHT = 36;
/** Horizontal space taken by the traffic lights. */
export const TRAFFIC_LIGHTS_WIDTH = 78;

export function Titlebar({ children, inset = false, class: className }: { children?: ComponentChildren; inset?: boolean; class?: string }) {
  return (
    <div
      data-tauri-drag-region
      style={{ height: `${TITLEBAR_HEIGHT}px`, paddingLeft: inset ? `${TRAFFIC_LIGHTS_WIDTH}px` : undefined }}
      class={cn("flex shrink-0 items-center gap-1 px-2", className)}
    >
      {children}
    </div>
  );
}
