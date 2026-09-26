/**
 * Insertion line shown while dragging a sidebar item: drawn in the 2px row gap above or below
 * an item (the item must be `relative`).
 */
import { cn } from "@/lib/cn";

export function DropLine({ edge }: { edge: "top" | "bottom" | null }) {
  if (!edge) return null;
  return (
    <div
      aria-hidden
      data-drop-line={edge}
      class={cn(
        "pointer-events-none absolute right-1 left-1 z-10 h-[2px] rounded-full bg-accent",
        edge === "top" ? "-top-[2px]" : "-bottom-[2px]",
      )}
    />
  );
}
