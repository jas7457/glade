/**
 * Insertion line shown while dragging a sidebar item: drawn in the 2px row gap above or below
 * an item (the item must be `relative`). It starts where the dragged rows' content starts
 * (`indent`, see sidebar-metrics.ts), so it lines up with the sidebar grid.
 */
import { cn } from "@glade/app-core/lib/cn";
import { sidebarClass, type SidebarIndent } from "@glade/app-core/ui";

export function DropLine({ edge, indent = 0 }: { edge: "top" | "bottom" | null; indent?: SidebarIndent }) {
  if (!edge) return null;
  return (
    <div
      aria-hidden
      data-drop-line={edge}
      class={cn(
        "pointer-events-none absolute right-1 z-10 h-[2px] rounded-full bg-accent",
        sidebarClass.lineStart[indent],
        edge === "top" ? "-top-[2px]" : "-bottom-[2px]",
      )}
    />
  );
}
