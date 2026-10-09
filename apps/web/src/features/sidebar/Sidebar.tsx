/**
 * App sidebar content: titlebar drag region, New chat, Projects, Chats, Settings. In the
 * settings screen it shows the settings section list instead.
 *
 * I-213: the Projects header's "+" offers Add Project… and New Group… (a project without a
 * folder of its own; group rows look like projects with a layers icon).
 *
 * I-202: the Projects group lists only projects (always top level), dragged to reorder. The Chats
 * group is the standalone chat list: pinned chats, then standalone chats and their folders in
 * one manual order (`ChatList`); its header's "New Folder" makes a folder there.
 */
import type { WorkspaceSummary, Project } from "@glade/protocol";
import { useLocation, useNavigate } from "react-router";
import { FolderPlus, Layers, PanelLeft, Plus, Settings as SettingsIcon, SquarePen } from "lucide-preact";
import { routes } from "@glade/app-core/app/routes";
import { routeContext } from "@/app/paths";
import { cn } from "@glade/app-core/lib/cn";
import { IconButton, Kbd, Menu, MenuItem, SidebarGroup, SidebarItem, SidebarList, StatusDot, Titlebar, sidebarClass } from "@glade/app-core/ui";
import { envIdOf, sortedProjects, workspacesById } from "@glade/app-core/state/store";
import { openAddProject, openNewGroup, toggleSidebar } from "@glade/app-core/state/ui";
import { reorderProjects } from "@glade/app-core/state/actions";
import { primaryEnvironmentId } from "@glade/app-core/state/env-registry";
import { updateAvailable } from "@glade/app-core/state/version";
import { agentsBehind } from "@glade/app-core/state/agent-versions";
import { SettingsNav } from "@/features/settings";
import { DownEnvironmentRows } from "@/features/environments/DownEnvironmentRows";
import { ChatList, listArea } from "./ChatList";
import { ProjectGroup } from "./ProjectGroup";
import { createFolderAndRename } from "./folder-menu";
import { dropAreaProps, useSortable } from "./useSortable";

/** Drag area of the project list. */
const PROJECTS_AREA = "projects";

export const STANDALONE_CHAT_LIMIT = 10;

export function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const ctx = routeContext(location.pathname, workspacesById.value);

  const onChatRemoved = (chat: WorkspaceSummary) => navigate(chat.projectId ? routes.project(chat.projectId) : routes.home(envIdOf(chat)));
  const onProjectRemoved = (_project: Project) => navigate(routes.home());

  // New Chat always starts a standalone chat (I-214); project chats start from the project's +.
  const newChat = () => navigate(routes.home(ctx.envId));
  const list = sortedProjects.value;
  const newChatSelected = location.pathname === "/" || /^\/e\/[^/]+\/?$/.test(location.pathname);
  const projectSort = useSortable({
    group: "projects",
    ids: list.map((p) => p.id),
    onReorder: (ids) => void reorderProjects(ids),
    area: PROJECTS_AREA,
  });
  const newFolder = () => void createFolderAndRename({ envId: ctx.envId ?? primaryEnvironmentId() });

  return (
    <nav aria-label="Sidebar" class="flex h-full min-h-0 flex-col">
      <Titlebar inset class="justify-end">
        <IconButton size="sm" label="Toggle Sidebar (⌘B)" onClick={toggleSidebar}>
          <PanelLeft />
        </IconButton>
      </Titlebar>

      {ctx.isSettings ? (
        <SettingsNav />
      ) : (
        <>
          <SidebarList class={sidebarClass.paddingX}>
            <SidebarItem
              icon={<SquarePen />}
              label="New Chat"
              selected={newChatSelected}
              onSelect={newChat}
              trailing={<Kbd keys="⌘N" class="border-0 bg-transparent" />}
            />
          </SidebarList>

          <div class={cn("min-h-0 flex-1 overflow-y-auto pb-3", sidebarClass.paddingX)}>
            <SidebarGroup
              title="Projects"
              collapsible
              actions={
                // I-213: a project (a folder) or a group (a name; its chats pick their folders).
                <Menu
                  align="end"
                  trigger={
                    <IconButton size="sm" label="Add Project or Group" tooltip={false}>
                      <Plus />
                    </IconButton>
                  }
                >
                  <MenuItem icon={<FolderPlus />} onSelect={openAddProject}>
                    Add Project…
                  </MenuItem>
                  <MenuItem icon={<Layers />} onSelect={openNewGroup}>
                    New Group…
                  </MenuItem>
                </Menu>
              }
            >
              {list.length === 0 ? (
                <>
                  <SidebarItem icon={<FolderPlus />} label="Add a project…" onSelect={openAddProject} class="text-fg-muted" />
                  <SidebarItem icon={<Layers />} label="New group…" onSelect={openNewGroup} class="text-fg-muted" />
                  <DownEnvironmentRows />
                </>
              ) : (
                <SidebarList {...dropAreaProps(PROJECTS_AREA)}>
                  {list.map((p, i) => (
                    <ProjectGroup
                      key={p.id}
                      project={p}
                      sort={projectSort.bind(p.id, i, list.length)}
                      selected={ctx.projectId === p.id && ctx.workspaceId === null}
                      selectedChatId={ctx.workspaceId}
                      onChatRemoved={onChatRemoved}
                      onProjectRemoved={onProjectRemoved}
                    />
                  ))}
                  {/* I-132: remote environments that are down stay listed, greyed, with their status. */}
                  <DownEnvironmentRows />
                </SidebarList>
              )}
            </SidebarGroup>

            <SidebarGroup
              title="Chats"
              collapsible
              actions={
                <IconButton size="sm" label="New Folder" onClick={newFolder}>
                  <FolderPlus />
                </IconButton>
              }
            >
              <div {...dropAreaProps(listArea(null))}>
                <ChatList projectId={null} selectedChatId={ctx.workspaceId} limit={STANDALONE_CHAT_LIMIT} emptyLabel="No chats yet" onRemoved={onChatRemoved} />
              </div>
            </SidebarGroup>
          </div>

          <div class={cn("flex shrink-0 items-center gap-1 border-t border-separator py-2", sidebarClass.paddingX)}>
            <SidebarItem
              class="min-w-0 flex-1"
              icon={<SettingsIcon />}
              label="Settings"
              // I-149: a quiet dot when a newer Glade is on main (Settings → General says more).
              badge={
                // Glade itself or one of this Mac's agents (I-210) has an update.
                updateAvailable.value || agentsBehind(null).value > 0 ? (
                  <StatusDot tone="info" label={updateAvailable.value ? "Update available" : "Agent update available"} />
                ) : undefined
              }
              onSelect={() => navigate(routes.settings())}
              trailing={<Kbd keys="⌘," class="border-0 bg-transparent" />}
            />
          </div>
        </>
      )}
    </nav>
  );
}
