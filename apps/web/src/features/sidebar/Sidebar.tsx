/**
 * App sidebar content: titlebar drag region, New chat, Projects, Chats, Settings (+ usage gauge). In the
 * settings screen it shows the settings section list instead.
 */
import type { WorkspaceSummary, Project } from "@pi-ui/protocol";
import { useLocation, useNavigate } from "react-router";
import { FolderPlus, PanelLeft, Plus, Settings as SettingsIcon, SquarePen } from "lucide-preact";
import { routes } from "@/app/routes";
import { routeContext } from "@/app/paths";
import { cn } from "@/lib/cn";
import { IconButton, Kbd, SidebarGroup, SidebarItem, SidebarList, Titlebar, sidebarClass } from "@/ui";
import { workspacesById, workspacesForProject, sortedProjects } from "@/state/store";
import { openAddProject, toggleSidebar } from "@/state/ui";
import { reorderProjects } from "@/state/actions";
import { SettingsNav } from "@/features/settings";
import { ChatList } from "./ChatList";
import { ProjectGroup } from "./ProjectGroup";
import { UsageGauge } from "./UsageGauge";
import { useSortable } from "./useSortable";

export const STANDALONE_CHAT_LIMIT = 10;

export function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const ctx = routeContext(location.pathname, workspacesById.value);

  const onChatRemoved = (chat: WorkspaceSummary) => navigate(chat.projectId ? routes.project(chat.projectId) : routes.home());
  const onProjectRemoved = (_project: Project) => navigate(routes.home());

  const newChat = () => navigate(ctx.projectId ? routes.project(ctx.projectId) : routes.home());
  const projects = sortedProjects.value;
  const standalone = workspacesForProject(null);
  const newChatSelected = location.pathname === "/";
  const projectSort = useSortable({
    group: "projects",
    ids: projects.map((p) => p.id),
    onReorder: (ids) => void reorderProjects(ids),
  });

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
                <IconButton size="sm" label="Add Project…" onClick={openAddProject}>
                  <Plus />
                </IconButton>
              }
            >
              {projects.length === 0 ? (
                <SidebarItem icon={<FolderPlus />} label="Add a project…" onSelect={openAddProject} class="text-fg-muted" />
              ) : (
                <SidebarList>
                  {projects.map((p, i) => (
                    <ProjectGroup
                      key={p.id}
                      project={p}
                      sort={projectSort.bind(p.id, i, projects.length)}
                      canMoveUp={i > 0}
                      canMoveDown={i < projects.length - 1}
                      selected={ctx.projectId === p.id && ctx.workspaceId === null}
                      selectedChatId={ctx.workspaceId}
                      onChatRemoved={onChatRemoved}
                      onProjectRemoved={onProjectRemoved}
                    />
                  ))}
                </SidebarList>
              )}
            </SidebarGroup>

            <SidebarGroup title="Chats" collapsible>
              <ChatList
                chats={standalone}
                listId={null}
                selectedChatId={ctx.workspaceId}
                limit={STANDALONE_CHAT_LIMIT}
                emptyLabel="No chats yet"
                onRemoved={onChatRemoved}
              />
            </SidebarGroup>
          </div>

          <div class={cn("flex shrink-0 items-center gap-1 border-t border-separator py-2", sidebarClass.paddingX)}>
            <SidebarItem
              class="min-w-0 flex-1"
              icon={<SettingsIcon />}
              label="Settings"
              onSelect={() => navigate(routes.settings())}
              trailing={<Kbd keys="⌘," class="border-0 bg-transparent" />}
            />
            <UsageGauge />
          </div>
        </>
      )}
    </nav>
  );
}
