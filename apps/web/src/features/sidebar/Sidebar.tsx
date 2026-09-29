/**
 * App sidebar content: titlebar drag region, New chat, Projects, Chats, Settings. In the
 * settings screen it shows the settings section list instead.
 *
 * Folders (I-165): the project list's top level mixes projects and top-level folders (which hold
 * projects and standalone chats). It's one sortable list of the rendered rows (a folder's row,
 * then its projects while it's open); where a dragged project lands (in a folder or not) is
 * `resolveTreeDrop`'s call, dropping it on a folder's row puts it in that folder. The Chats
 * group lists the standalone chats that aren't in a folder (and takes chats dragged out of one).
 */
import type { WorkspaceSummary, Project } from "@glade/protocol";
import { useLocation, useNavigate } from "react-router";
import { FolderPlus, PanelLeft, Plus, Settings as SettingsIcon, SquarePen } from "lucide-preact";
import { routes } from "@glade/app-core/app/routes";
import { routeContext } from "@/app/paths";
import { cn } from "@glade/app-core/lib/cn";
import { IconButton, Kbd, SidebarGroup, SidebarItem, SidebarList, StatusDot, Titlebar, sidebarClass } from "@glade/app-core/ui";
import { envIdOf, foldersById, looseWorkspaces, projectsById, sidebarEntries, workspacesForProject, workspacesById, workspacesInFolder } from "@glade/app-core/state/store";
import { closedProjects, openAddProject, toggleSidebar } from "@glade/app-core/state/ui";
import { moveProject } from "@glade/app-core/state/actions";
import { applyProjectDrop, moveProjectToFolder } from "@glade/app-core/state/folder-actions";
import { primaryEnvironmentId } from "@glade/app-core/state/env-registry";
import { resolveTreeDrop, type TreeRow } from "@glade/app-core/state/folders";
import { updateAvailable } from "@glade/app-core/state/version";
import { SettingsNav } from "@/features/settings";
import { DownEnvironmentRows } from "@/features/environments/DownEnvironmentRows";
import { ChatList, dropKindOf } from "./ChatList";
import { FolderGroup } from "./FolderGroup";
import { ProjectGroup } from "./ProjectGroup";
import { createFolderAndRename } from "./folder-menu";
import { dropTargetProps, useSortable } from "./useSortable";

/** Drag kind of projects (top-level folders take them). */
const PROJECT_KIND = "project";

export const STANDALONE_CHAT_LIMIT = 10;

export function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const ctx = routeContext(location.pathname, workspacesById.value);

  const onChatRemoved = (chat: WorkspaceSummary) => navigate(chat.projectId ? routes.project(chat.projectId) : routes.home(envIdOf(chat)));
  const onProjectRemoved = (_project: Project) => navigate(routes.home());

  const newChat = () => navigate(ctx.projectId ? routes.project(ctx.projectId) : routes.home(ctx.envId));
  const entries = sidebarEntries.value;
  const standalone = looseWorkspaces(null);
  const newChatSelected = location.pathname === "/" || /^\/e\/[^/]+\/?$/.test(location.pathname);
  const closed = closedProjects.value;
  // The rendered rows of the project list, in document order.
  const rows: TreeRow[] = entries.flatMap((e): TreeRow[] =>
    e.kind === "project"
      ? [{ id: e.project.id, kind: "project", parent: null }]
      : [{ id: e.folder.id, kind: "folder", parent: null }, ...(closed.has(e.folder.id) ? [] : e.projects.map((p): TreeRow => ({ id: p.id, kind: "project", parent: e.folder.id })))],
  );
  const rowIndex = new Map(rows.map((r, i) => [r.id, i]));
  const openFolders = new Set(entries.flatMap((e) => (e.kind === "folder" && !closed.has(e.folder.id) ? [e.folder.id] : [])));
  const projectSort = useSortable({
    group: "projects",
    ids: rows.map((r) => r.id),
    onReorder: (ids, movedId) => void applyProjectDrop(resolveTreeDrop(rows, ids, movedId, openFolders)),
    into: {
      kind: PROJECT_KIND,
      band: true,
      canDrop: (id, target) => {
        const project = projectsById.value.get(id);
        const folder = foldersById.value.get(target);
        return !!project && !!folder && folder.projectId === null && project.folderId !== target && envIdOf(folder) === envIdOf(project);
      },
      onDrop: (id, target) => void moveProjectToFolder(id, target || null),
    },
  });
  const bind = (id: string) => projectSort.bind(id, rowIndex.get(id) ?? 0, rows.length);
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
                <>
                  <IconButton size="sm" label="New Folder" onClick={newFolder}>
                    <FolderPlus />
                  </IconButton>
                  <IconButton size="sm" label="Add Project…" onClick={openAddProject}>
                    <Plus />
                  </IconButton>
                </>
              }
            >
              {entries.length === 0 ? (
                <>
                  <SidebarItem icon={<FolderPlus />} label="Add a project…" onSelect={openAddProject} class="text-fg-muted" />
                  <DownEnvironmentRows />
                </>
              ) : (
                <SidebarList>
                  {entries.map((e, i) => {
                    const first = i === 0;
                    const last = i === entries.length - 1;
                    if (e.kind === "project") {
                      const p = e.project;
                      return (
                        <ProjectGroup
                          key={p.id}
                          project={p}
                          sort={bind(p.id)}
                          canMoveUp={!first}
                          canMoveDown={!last}
                          selected={ctx.projectId === p.id && ctx.workspaceId === null}
                          selectedChatId={ctx.workspaceId}
                          onChatRemoved={onChatRemoved}
                          onProjectRemoved={onProjectRemoved}
                        />
                      );
                    }
                    const { folder } = e;
                    const chats = workspacesInFolder(folder.id);
                    const fsort = bind(folder.id);
                    return (
                      <FolderGroup
                        key={folder.id}
                        folder={folder}
                        indent={0}
                        statuses={[...e.projects.flatMap((p) => workspacesForProject(p.id).map((c) => c.status)), ...chats.map((c) => c.status)]}
                        accept={`${PROJECT_KIND} ${dropKindOf(null)}`}
                        sort={fsort}
                        dragging={fsort.dragging}
                        canMoveUp={!first}
                        canMoveDown={!last}
                        onMove={(delta) => void moveProject(folder.id, delta)}
                        contentsLabel="Its projects and chats"
                      >
                        {e.projects.map((p, j) => (
                          <ProjectGroup
                            key={p.id}
                            project={p}
                            indent={1}
                            folderId={folder.id}
                            sort={bind(p.id)}
                            canMoveUp={j > 0}
                            canMoveDown={j < e.projects.length - 1}
                            selected={ctx.projectId === p.id && ctx.workspaceId === null}
                            selectedChatId={ctx.workspaceId}
                            onChatRemoved={onChatRemoved}
                            onProjectRemoved={onProjectRemoved}
                          />
                        ))}
                        {(chats.length > 0 || e.projects.length === 0) && (
                          <ChatList
                            chats={chats}
                            listId={null}
                            folderId={folder.id}
                            selectedChatId={ctx.workspaceId}
                            limit={STANDALONE_CHAT_LIMIT}
                            indent={1}
                            emptyLabel="Empty"
                            onRemoved={onChatRemoved}
                          />
                        )}
                      </FolderGroup>
                    );
                  })}
                  {/* I-132: remote environments that are down stay listed, greyed, with their status. */}
                  <DownEnvironmentRows />
                </SidebarList>
              )}
            </SidebarGroup>

            <SidebarGroup title="Chats" collapsible>
              <div {...dropTargetProps("", dropKindOf(null))}>
                <ChatList
                  chats={standalone}
                  listId={null}
                  selectedChatId={ctx.workspaceId}
                  limit={STANDALONE_CHAT_LIMIT}
                  emptyLabel="No chats yet"
                  onRemoved={onChatRemoved}
                />
              </div>
            </SidebarGroup>
          </div>

          <div class={cn("flex shrink-0 items-center gap-1 border-t border-separator py-2", sidebarClass.paddingX)}>
            <SidebarItem
              class="min-w-0 flex-1"
              icon={<SettingsIcon />}
              label="Settings"
              // I-149: a quiet dot when a newer Glade is on main (Settings → General says more).
              badge={updateAvailable.value ? <StatusDot tone="info" label="Update available" /> : undefined}
              onSelect={() => navigate(routes.settings())}
              trailing={<Kbd keys="⌘," class="border-0 bg-transparent" />}
            />
          </div>
        </>
      )}
    </nav>
  );
}
