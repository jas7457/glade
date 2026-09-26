/**
 * "Source folder" well of the Create Project dialog: an Add button that opens the native folder
 * dialog, or the chosen folder (name + full path) with Change / Remove actions.
 */
import { Folder, FolderPlus, X } from "lucide-preact";
import { Button, IconButton } from "@/ui";
import { folderName } from "./validation";

export interface SourceFolderProps {
  /** Chosen folder, or null. */
  path: string | null;
  /** The native dialog is open. */
  picking: boolean;
  onPick: () => void;
  onRemove: () => void;
}

const wellClass = "flex min-h-12 items-center gap-2.5 rounded-[7px] bg-surface px-3 py-2 shadow-[0_0_0_0.5px_var(--pi-separator)]";

export function SourceFolder({ path, picking, onPick, onRemove }: SourceFolderProps) {
  if (!path) {
    return (
      <div class={wellClass}>
        <span class="flex-1 text-fg-subtle">No folder selected</span>
        <Button onClick={onPick} disabled={picking}>
          <FolderPlus size={14} />
          {picking ? "Choosing…" : "Add"}
        </Button>
      </div>
    );
  }
  return (
    <div class={wellClass} aria-label="Source folder">
      <Folder size={18} class="shrink-0 text-accent" />
      <div class="flex min-w-0 flex-1 flex-col">
        <span class="truncate font-medium">{folderName(path)}</span>
        <span class="truncate font-mono text-[0.85rem] text-fg-muted" title={path}>
          {path}
        </span>
      </div>
      <Button size="sm" onClick={onPick} disabled={picking}>
        {picking ? "Choosing…" : "Change…"}
      </Button>
      <IconButton size="sm" label="Remove Folder" onClick={onRemove} disabled={picking}>
        <X />
      </IconButton>
    </div>
  );
}
