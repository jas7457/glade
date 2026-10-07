/**
 * A project in the sidebar: a collapsible row (folder icon + name, hover "+" and "…") followed by
 * its chat list (`ChatList`, I-202: pinned chats, then its chats and folders in one manual order).
 * The row is the drag handle for reordering projects (the whole group moves); projects are always
 * top level. The group is its chats' drag area: nothing dragged from it can leave it.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { useNavigate } from "react-router";
import { Copy, Folder, FolderOpen, FolderPlus, GitBranch, MoreHorizontal, Pencil, Plus, SquarePen, Trash2 } from "lucide-preact";
import { aggregateChatStatus, type WorkspaceSummary, type Project } from "@glade/protocol";
import { routes } from "@glade/app-core/app/routes";
import { ContextMenu, IconButton, Menu, MenuItem, MenuLabel, MenuSeparator, SidebarItem, StatusIndicator, confirm, sidebarClass } from "@glade/app-core/ui";
import { cn } from "@glade/app-core/lib/cn";
import { envIdOf, workspacesForProject } from "@glade/app-core/state/store";
import { RemoteMarker } from "@/features/environments/RemoteMarker";
import { closedProjects, setProjectOpen } from "@glade/app-core/state/ui";
import { removeProject, renameProject } from "@glade/app-core/state/actions";
import { notify } from "@glade/app-core/state/toasts";
import { loadProjectGit, newChatWorktree, projectGit } from "@glade/app-core/state/worktrees";
import { ChatList, listArea } from "./ChatList";
import { DropLine } from "./DropLine";
import { InlineRename } from "./InlineRename";
import { createFolderAndRename } from "./folder-menu";
import { dropAreaProps, type SortBinding } from "./useSortable";

export const PROJECT_CHAT_LIMIT = 5;

export interface ProjectGroupProps {
  project: Project;
  /** Project whose new-chat screen is showing. */
  selected: boolean;
  selectedChatId: string | null;
  onChatRemoved?: (chat: WorkspaceSummary) => void;
  onProjectRemoved?: (project: Project) => void;
  /** Drag-to-reorder wiring from the project list. */
  sort?: SortBinding;
}

export function ProjectGroup({
  project,
  selected,
  selectedChatId,
  onChatRemoved,
  onProjectRemoved,
  sort,
}: ProjectGroupProps) {
  const navigate = useNavigate();
  const open = !closedProjects.value.has(project.id);
  const list = workspacesForProject(project.id);
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const renaming = useRef(false);
  const onCloseAutoFocus = (e: Event) => {
    if (renaming.current) e.preventDefault();
    renaming.current = false;
  };

  const newChat = () => navigate(routes.project(project.id));
  // "New Chat in Worktree" (I-096) for git projects: the new-chat screen opens with the switch on.
  useEffect(() => {
    void loadProjectGit(project.id);
  }, [project.id]);
  const isRepo = projectGit.value.get(project.id)?.isRepo ?? false;
  const newWorktreeChat = () => {
    newChatWorktree.value = project.id;
    navigate(routes.project(project.id));
  };
  const remove = async () => {
    const count = list.length;
    const ok = await confirm({
      title: "Remove project?",
      subject: project.name,
      message:
        count > 0
          ? `and its ${count} chat${count === 1 ? "" : "s"} will be deleted. The folder on disk isn't touched.`
          : "will be removed from Glade. The folder on disk isn't touched.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (ok && (await removeProject(project.id))) onProjectRemoved?.(project);
  };
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(project.path);
      notify("success", "Path copied");
    } catch {
      notify("error", "Could not copy the path");
    }
  };

  const items = (
    <>
      <MenuLabel>
        <span class="block max-w-[260px] truncate font-normal" title={project.path}>
          {project.path}
        </span>
      </MenuLabel>
      <MenuItem icon={<SquarePen />} onSelect={newChat}>New Chat</MenuItem>
      {isRepo && <MenuItem icon={<GitBranch />} onSelect={newWorktreeChat}>New Chat in Worktree</MenuItem>}
      <MenuSeparator />
      <MenuItem
        icon={<Pencil />}
        onSelect={() => {
          renaming.current = true;
          setEditing(true);
        }}
      >
        Rename
      </MenuItem>
      <MenuItem icon={<Copy />} onSelect={() => void copyPath()}>Copy Path</MenuItem>
      <MenuItem icon={<FolderPlus />} onSelect={() => void createFolderAndRename({ projectId: project.id })}>New Folder</MenuItem>
      <MenuSeparator />
      <MenuItem destructive icon={<Trash2 />} onSelect={() => void remove()}>
        Remove Project…
      </MenuItem>
    </>
  );

  // Collapsed projects surface the most urgent status of their chats.
  const aggregate = open ? "idle" : aggregateChatStatus(list.map((c) => c.status));

  return (
    <div
      data-project-id={project.id}
      {...sort?.item}
      {...dropAreaProps(listArea(project.id))}
      class={cn("relative", sidebarClass.rows, open && sidebarClass.subgroupGap, sidebarClass.dropShiftTransition, sort?.shifted && sidebarClass.dropShift, sort?.dragging && "opacity-40")}
    >
      <DropLine edge={sort?.dropEdge ?? null} />
      <ContextMenu content={items} onCloseAutoFocus={onCloseAutoFocus} disabled={editing}>
        <SidebarItem
          {...(editing ? {} : sort?.handle)}
          label={project.name}
          title={project.path}
          icon={open ? <FolderOpen /> : <Folder />}
          badge={<RemoteMarker envId={envIdOf(project)} />}
          selected={selected}
          aria-expanded={open}
          onSelect={() => setProjectOpen(project.id, !open)}
          trailing={aggregate !== "idle" ? <StatusIndicator status={aggregate} /> : undefined}
          actionsVisible={menuOpen}
          editor={
            editing ? (
              <InlineRename
                value={project.name}
                aria-label="Project name"
                onCommit={(name) => {
                  setEditing(false);
                  void renameProject(project.id, name);
                }}
                onCancel={() => setEditing(false)}
              />
            ) : undefined
          }
          actions={
            <>
              <IconButton size="sm" label={`New chat in ${project.name}`} onClick={newChat}>
                <Plus />
              </IconButton>
              <Menu
                open={menuOpen}
                onOpenChange={setMenuOpen}
                onCloseAutoFocus={onCloseAutoFocus}
                trigger={
                  <IconButton size="sm" label="Project actions" tooltip={false}>
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
      {open && <ChatList projectId={project.id} selectedChatId={selectedChatId} limit={PROJECT_CHAT_LIMIT} indent={1} emptyLabel="No chats" onRemoved={onChatRemoved} />}
    </div>
  );
}
