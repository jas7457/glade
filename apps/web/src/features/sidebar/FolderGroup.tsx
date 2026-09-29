/**
 * A folder in the sidebar (I-165): a collapsible row (stacked-folders icon + name, hover "…")
 * followed by its contents while open. Top-level folders hold projects and standalone chats
 * (`Sidebar`), a project's folders hold some of its chats (`ProjectGroup`).
 *
 * The row is a drop target for the items it takes (`accept`, see `useSortable`'s `into`) and,
 * with `sort`, the drag handle for reordering it in its list. Its menu: Rename (also right after
 * "New Folder"), Move Up / Move Down, Delete Folder (the contents move back out).
 */
import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";
import { ArrowDown, ArrowUp, Folders, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-preact";
import type { ChatStatus, Folder } from "@glade/protocol";
import { aggregateChatStatus } from "@glade/protocol";
import { ContextMenu, IconButton, Menu, MenuItem, MenuSeparator, SidebarItem, StatusIndicator, confirm, sidebarClass, type SidebarIndent } from "@glade/app-core/ui";
import { cn } from "@glade/app-core/lib/cn";
import { closedProjects, setProjectOpen } from "@glade/app-core/state/ui";
import { deleteFolder, renameFolder } from "@glade/app-core/state/folder-actions";
import { DropLine } from "./DropLine";
import { InlineRename } from "./InlineRename";
import { renamingFolderId } from "./folder-menu";
import { dropIntoTarget, dropTargetProps, type SortBinding } from "./useSortable";

export interface FolderGroupProps {
  folder: Folder;
  /** Indent of the row (its icon); the contents sit one level deeper. */
  indent: SidebarIndent;
  /** Statuses of everything inside (a closed folder shows the most urgent). */
  statuses: ChatStatus[];
  /** Drag kinds it takes (space separated). */
  accept: string;
  /** Drag-to-reorder wiring of the row (measured element = the row). */
  sort?: SortBinding;
  /** The whole folder is being dragged (dims it). */
  dragging?: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onMove?: (delta: -1 | 1) => void;
  /** "+" on hover (e.g. New Chat in a project folder's project); omitted = none. */
  onAdd?: { label: string; run: () => void };
  /** What "Delete Folder…" says moves out. */
  contentsLabel: string;
  children: ComponentChildren;
}

export function FolderGroup({ folder, indent, statuses, accept, sort, dragging, canMoveUp = false, canMoveDown = false, onMove, onAdd, contentsLabel, children }: FolderGroupProps) {
  const open = !closedProjects.value.has(folder.id);
  const editing = renamingFolderId.value === folder.id;
  const [menuOpen, setMenuOpen] = useState(false);
  const renaming = useRef(false);
  const onCloseAutoFocus = (e: Event) => {
    if (renaming.current) e.preventDefault();
    renaming.current = false;
  };
  const dropping = dropIntoTarget.value === folder.id;

  const remove = async () => {
    const ok = await confirm({
      title: "Delete folder?",
      subject: folder.name,
      message: `will be deleted. ${contentsLabel} move${contentsLabel.endsWith("s") ? "" : "s"} back out; nothing else is deleted.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (ok) await deleteFolder(folder.id);
  };

  const items = (
    <>
      <MenuItem
        icon={<Pencil />}
        onSelect={() => {
          renaming.current = true;
          renamingFolderId.value = folder.id;
        }}
      >
        Rename
      </MenuItem>
      {onMove && (
        <>
          <MenuSeparator />
          <MenuItem icon={<ArrowUp />} disabled={!canMoveUp} onSelect={() => onMove(-1)}>
            Move Up
          </MenuItem>
          <MenuItem icon={<ArrowDown />} disabled={!canMoveDown} onSelect={() => onMove(1)}>
            Move Down
          </MenuItem>
        </>
      )}
      <MenuSeparator />
      <MenuItem destructive icon={<Trash2 />} onSelect={() => void remove()}>
        Delete Folder…
      </MenuItem>
    </>
  );

  const aggregate = open ? "idle" : aggregateChatStatus(statuses);
  const stopRename = () => {
    if (renamingFolderId.value === folder.id) renamingFolderId.value = null;
  };

  return (
    <div data-folder-id={folder.id} class={cn("relative", sidebarClass.rows, open && sidebarClass.subgroupGap, dragging && "opacity-40")}>
      <div {...sort?.item} {...dropTargetProps(folder.id, accept)} class="relative">
        <DropLine edge={sort?.dropEdge ?? null} indent={indent} />
        <ContextMenu content={items} onCloseAutoFocus={onCloseAutoFocus} disabled={editing}>
          <SidebarItem
            {...(editing ? {} : sort?.handle)}
            label={folder.name}
            icon={<Folders />}
            indent={indent}
            aria-expanded={open}
            onSelect={() => setProjectOpen(folder.id, !open)}
            class={cn(dropping && "bg-accent/15 ring-2 ring-accent/60 ring-inset")}
            trailing={aggregate !== "idle" ? <StatusIndicator status={aggregate} /> : undefined}
            actionsVisible={menuOpen}
            editor={
              editing ? (
                <InlineRename
                  value={folder.name}
                  aria-label="Folder name"
                  onCommit={(name) => {
                    stopRename();
                    void renameFolder(folder.id, name);
                  }}
                  onCancel={stopRename}
                />
              ) : undefined
            }
            actions={
              <>
                {onAdd && (
                  <IconButton size="sm" label={onAdd.label} onClick={onAdd.run}>
                    <Plus />
                  </IconButton>
                )}
                <Menu
                  open={menuOpen}
                  onOpenChange={setMenuOpen}
                  onCloseAutoFocus={onCloseAutoFocus}
                  trigger={
                    <IconButton size="sm" label="Folder actions" tooltip={false}>
                      <MoreHorizontal />
                    </IconButton>
                  }
                >
                  {items}
                </Menu>
              </>
            }
          />
        </ContextMenu>
      </div>
      {open && children}
    </div>
  );
}
