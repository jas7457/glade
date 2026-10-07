/**
 * Insertion line shown while dragging a sidebar item (I-202): an accent line with a small hollow
 * dot at its start, drawn in the gap above or below an item (the item must be `relative`). The
 * rows after it slide down to open that gap (`sidebarClass.dropShift`), so the line sits in the
 * middle of it. It starts where the item will land (`indent`, see sidebar-metrics.ts): the top
 * level of a list, or one level deeper inside a folder.
 */
import { cn } from "@glade/app-core/lib/cn";
import { sidebarClass, type SidebarIndent } from "@glade/app-core/ui";

export function DropLine({ edge, indent = 0 }: { edge: "top" | "bottom" | null; indent?: SidebarIndent }) {
  if (!edge) return null;
  return (
    <div
      aria-hidden
      data-drop-line={edge}
      data-drop-indent={indent}
      class={cn("pointer-events-none absolute right-1 z-10 h-[2px] rounded-full bg-accent", sidebarClass.lineStart[indent], edge === "top" ? "-top-[5px]" : "-bottom-[4px]")}
    >
      <span class="absolute -top-[2px] -left-[5px] size-1.5 rounded-full border-[1.5px] border-accent bg-sidebar" />
    </div>
  );
}
