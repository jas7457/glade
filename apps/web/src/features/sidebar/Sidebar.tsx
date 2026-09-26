/**
 * App sidebar content: titlebar drag region, New chat, Projects, Chats, Settings. In the
 * settings screen it shows the settings section list instead.
 */
import type { ChatSummary, Project } from "@pi-ui/protocol";
import { useLocation, useNavigate } from "react-router";
import { FolderPlus, PanelLeft, Plus, Settings as SettingsIcon, SquarePen } from "lucide-preact";
import { routes } from "@/app/routes";
import { routeContext } from "@/app/paths";
import { Disclosure, IconButton, Kbd, SidebarItem, Titlebar } from "@/ui";
import { chatsById, chatsForProject, sortedProjects } from "@/state/store";
import { openAddProject, toggleSidebar } from "@/state/ui";
import { SettingsNav } from "@/features/settings";
import { ChatList } from "./ChatList";
import { ProjectGroup } from "./ProjectGroup";

export const STANDALONE_CHAT_LIMIT = 10;

export function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const ctx = routeContext(location.pathname, chatsById.value);

  const onChatRemoved = (chat: ChatSummary) => navigate(chat.projectId ? routes.project(chat.projectId) : routes.home());
  const onProjectRemoved = (_project: Project) => navigate(routes.home());

  const newChat = () => navigate(ctx.projectId ? routes.project(ctx.projectId) : routes.home());
  const projects = sortedProjects.value;
  const standalone = chatsForProject(null);
  const newChatSelected = location.pathname === "/";

  return (
    <nav aria-label="Sidebar" class="flex h-full min-h-0 flex-col">
      <Titlebar inset class="justify-end">
        <IconButton size="sm" label="Toggle Sidebar (⌘\)" onClick={toggleSidebar}>
          <PanelLeft />
        </IconButton>
      </Titlebar>

      {ctx.isSettings ? (
        <SettingsNav />
      ) : (
        <>
          <div class="flex flex-col gap-px px-2.5 pb-2">
            <SidebarItem
              icon={<SquarePen />}
              label="New Chat"
              selected={newChatSelected}
              onSelect={newChat}
              trailing={<Kbd keys="⌘N" class="border-0 bg-transparent" />}
            />
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
            <Disclosure
              variant="section"
              label="Projects"
              class="mb-3"
              actions={
                <IconButton size="sm" label="Add Project…" onClick={openAddProject}>
                  <Plus />
                </IconButton>
              }
            >
              {projects.length === 0 ? (
                <SidebarItem icon={<FolderPlus />} label="Add a project…" onSelect={openAddProject} class="text-fg-muted" />
              ) : (
                <div class="flex flex-col gap-px">
                  {projects.map((p) => (
                    <ProjectGroup
                      key={p.id}
                      project={p}
                      selected={ctx.projectId === p.id && ctx.chatId === null}
                      selectedChatId={ctx.chatId}
                      onChatRemoved={onChatRemoved}
                      onProjectRemoved={onProjectRemoved}
                    />
                  ))}
                </div>
              )}
            </Disclosure>

            <Disclosure variant="section" label="Chats">
              <ChatList
                chats={standalone}
                selectedChatId={ctx.chatId}
                limit={STANDALONE_CHAT_LIMIT}
                emptyLabel="No chats yet"
                onRemoved={onChatRemoved}
              />
            </Disclosure>
          </div>

          <div class="shrink-0 border-t border-separator px-2.5 py-2">
            <SidebarItem
              icon={<SettingsIcon />}
              label="Settings"
              onSelect={() => navigate(routes.settings())}
              trailing={<Kbd keys="⌘," class="border-0 bg-transparent" />}
            />
          </div>
        </>
      )}
    </nav>
  );
}
