/**
 * A folder in the sidebar (I-165, I-202): a collapsible row (stacked-folders icon + name, hover
 * "…") followed by its chats while open. A project's folders hold some of its chats, the Chats
 * section's hold standalone chats (`ChatList`); folders never hold projects.
 *
 * The row is a drop target for the chats it takes (`accept`, see `useSortable`'s `into`; tinted
 * and outlined while one would go in) and, with `tree`, the drag handle for moving it in its list
 * (the whole folder dims). Its menu: Rename (also right after "New Folder"), Delete Folder (its
 * chats take its place).
 */
import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";
import { Folders, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-preact";
import type { ChatStatus, Folder } from "@glade/protocol";
import { aggregateChatStatus } from "@glade/protocol";
import { ContextMenu, IconButton, Menu, MenuItem, MenuSeparator, SidebarItem, StatusIndicator, confirm, sidebarClass, type SidebarIndent } from "@glade/app-core/ui";
import { cn } from "@glade/app-core/lib/cn";
import { closedProjects, setProjectOpen } from "@glade/app-core/state/ui";
import { deleteFolder, renameFolder } from "@glade/app-core/state/folder-actions";
import { DropLine } from "./DropLine";
import { InlineRename } from "./InlineRename";
import { renamingFolderId } from "./folder-menu";
import { dropIntoTarget, dropTargetProps, type TreeBinding } from "./useSortable";

export interface FolderGroupProps {
  folder: Folder;
  /** Indent of the row (its icon); the contents sit one level deeper. */
  indent: SidebarIndent;
  /** Statuses of everything inside (a closed folder shows the most urgent). */
  statuses: ChatStatus[];
  /** Drag kinds it takes (space separated). */
  accept: string;
  /** Drag wiring of the row (measured element = the row) in its list's tree. */
  tree?: TreeBinding;
  /** "+" on hover (e.g. New Chat in a project folder's project); omitted = none. */
  onAdd?: { label: string; run: () => void };
  /** What "Delete Folder…" says moves out. */
  contentsLabel: string;
  children: ComponentChildren;
}

export function FolderGroup({ folder, indent, statuses, accept, tree, onAdd, contentsLabel, children }: FolderGroupProps) {
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
    <div data-folder-id={folder.id} class={cn("relative", sidebarClass.rows, open && sidebarClass.subgroupGap, tree?.dragging && "opacity-40")}>
      <div {...tree?.item} {...dropTargetProps(folder.id, accept)} class={cn("relative", sidebarClass.dropShiftTransition, tree?.shifted && sidebarClass.dropShift)}>
        <DropLine edge={tree?.drop?.edge ?? null} indent={Math.min(3, indent + (tree?.drop?.depth ?? 0)) as SidebarIndent} />
        <ContextMenu content={items} onCloseAutoFocus={onCloseAutoFocus} disabled={editing}>
          <SidebarItem
            {...(editing ? {} : tree?.handle)}
            label={folder.name}
            icon={<Folders />}
            indent={indent}
            aria-expanded={open}
            onSelect={() => setProjectOpen(folder.id, !open)}
            data-drop-target={dropping || undefined}
            class={cn(dropping && sidebarClass.dropTarget)}
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
