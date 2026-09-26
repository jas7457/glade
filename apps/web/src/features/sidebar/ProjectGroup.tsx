/**
 * A project folder in the sidebar: a collapsible row (folder icon + name, hover "+" and "…")
 * followed by its chats (pinned first, newest first).
 */
import { useRef, useState } from "preact/hooks";
import { useNavigate } from "react-router";
import { Folder, FolderOpen, MoreHorizontal, Pin, Plus } from "lucide-preact";
import { aggregateChatStatus, type ChatSummary, type Project } from "@pi-ui/protocol";
import { routes } from "@/app/routes";
import { ContextMenu, IconButton, Menu, MenuItem, MenuLabel, MenuSeparator, SidebarItem, StatusIndicator, confirm } from "@/ui";
import { chatsForProject } from "@/state/store";
import { closedProjects, setProjectOpen } from "@/state/ui";
import { removeProject, renameProject, setProjectPinned } from "@/state/actions";
import { notify } from "@/state/toasts";
import { ChatList } from "./ChatList";
import { InlineRename } from "./InlineRename";

export const PROJECT_CHAT_LIMIT = 5;

export interface ProjectGroupProps {
  project: Project;
  /** Project whose new-chat screen is showing. */
  selected: boolean;
  selectedChatId: string | null;
  onChatRemoved?: (chat: ChatSummary) => void;
  onProjectRemoved?: (project: Project) => void;
}

export function ProjectGroup({ project, selected, selectedChatId, onChatRemoved, onProjectRemoved }: ProjectGroupProps) {
  const navigate = useNavigate();
  const open = !closedProjects.value.has(project.id);
  const list = chatsForProject(project.id);
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const renaming = useRef(false);
  const onCloseAutoFocus = (e: Event) => {
    if (renaming.current) e.preventDefault();
    renaming.current = false;
  };

  const newChat = () => navigate(routes.project(project.id));
  const remove = async () => {
    const count = list.length + chatsForProject(project.id, true).filter((c) => c.archived).length;
    const ok = await confirm({
      title: `Remove “${project.name}”?`,
      message:
        count > 0
          ? `Its ${count} chat${count === 1 ? "" : "s"} will be deleted. The folder on disk is not touched.`
          : "The folder on disk is not touched.",
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
      <MenuSeparator />
      <MenuItem
        onSelect={() => {
          renaming.current = true;
          setEditing(true);
        }}
      >
        Rename
      </MenuItem>
      <MenuItem onSelect={() => void setProjectPinned(project.id, !project.pinned)}>{project.pinned ? "Unpin" : "Pin"}</MenuItem>
      <MenuItem onSelect={() => void copyPath()}>Copy Path</MenuItem>
      <MenuSeparator />
      <MenuItem destructive onSelect={() => void remove()}>
        Remove Project…
      </MenuItem>
    </>
  );

  // Collapsed projects surface the most urgent status of their chats.
  const aggregate = open ? "idle" : aggregateChatStatus(list.map((c) => c.status));

  return (
    <div data-project-id={project.id}>
      <ContextMenu content={items} onCloseAutoFocus={onCloseAutoFocus} disabled={editing}>
        <SidebarItem
          label={project.name}
          title={project.path}
          icon={open ? <FolderOpen /> : <Folder />}
          selected={selected}
          aria-expanded={open}
          onSelect={() => setProjectOpen(project.id, !open)}
          trailing={
            aggregate !== "idle" ? (
              <StatusIndicator status={aggregate} />
            ) : project.pinned ? (
              <Pin size={11} aria-label="Pinned" />
            ) : undefined
          }
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
