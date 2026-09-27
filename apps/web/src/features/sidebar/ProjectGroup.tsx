/**
 * A project folder in the sidebar: a collapsible row (folder icon + name, hover "+" and "…")
 * followed by its chats (pinned first, newest first). The row is the drag handle for reordering
 * projects (the whole group moves); "Move Up / Move Down" in its menu are the keyboard way.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { useNavigate } from "react-router";
import { Folder, FolderOpen, MoreHorizontal, Plus } from "lucide-preact";
import { aggregateChatStatus, type WorkspaceSummary, type Project } from "@glade/protocol";
import { routes } from "@/app/routes";
import { ContextMenu, IconButton, Menu, MenuItem, MenuLabel, MenuSeparator, SidebarItem, StatusIndicator, confirm, sidebarClass } from "@/ui";
import { cn } from "@/lib/cn";
import { workspacesForProject } from "@/state/store";
import { closedProjects, setProjectOpen } from "@/state/ui";
import { moveProject, removeProject, renameProject } from "@/state/actions";
import { notify } from "@/state/toasts";
import { loadProjectGit, newChatWorktree, projectGit } from "@/state/worktrees";
import { ChatList } from "./ChatList";
import { DropLine } from "./DropLine";
import { InlineRename } from "./InlineRename";
import type { SortBinding } from "./useSortable";

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
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}

export function ProjectGroup({
  project,
  selected,
  selectedChatId,
  onChatRemoved,
  onProjectRemoved,
  sort,
  canMoveUp = false,
  canMoveDown = false,
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
      <MenuItem onSelect={newChat}>New Chat</MenuItem>
      {isRepo && <MenuItem onSelect={newWorktreeChat}>New Chat in Worktree</MenuItem>}
      <MenuSeparator />
      <MenuItem
        onSelect={() => {
          renaming.current = true;
          setEditing(true);
        }}
      >
        Rename
      </MenuItem>
      <MenuItem onSelect={() => void copyPath()}>Copy Path</MenuItem>
      <MenuSeparator />
      <MenuItem disabled={!canMoveUp} onSelect={() => void moveProject(project.id, -1)}>
        Move Up
      </MenuItem>
      <MenuItem disabled={!canMoveDown} onSelect={() => void moveProject(project.id, 1)}>
        Move Down
      </MenuItem>
      <MenuSeparator />
      <MenuItem destructive onSelect={() => void remove()}>
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
      class={cn("relative", sidebarClass.rows, open && sidebarClass.subgroupGap, sort?.dragging && "opacity-40")}
    >
      <DropLine edge={sort?.dropEdge ?? null} />
      <ContextMenu content={items} onCloseAutoFocus={onCloseAutoFocus} disabled={editing}>
        <SidebarItem
          {...(editing ? {} : sort?.handle)}
          label={project.name}
          title={project.path}
          icon={open ? <FolderOpen /> : <Folder />}
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
      {open && (
        <ChatList
          chats={list}
          listId={project.id}
          selectedChatId={selectedChatId}
          limit={PROJECT_CHAT_LIMIT}
          indent={1}
          emptyLabel="No chats"
          onRemoved={onChatRemoved}
        />
      )}
    </div>
  );
}
