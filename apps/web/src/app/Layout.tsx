/**
 * App layout route: resizable/collapsible sidebar + main pane (<Outlet/>), status banners,
 * global shortcuts, the command palette and dialogs hosted at the root.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { Outlet, useLocation, useNavigate } from "react-router";
import { AlertTriangle, PanelLeft } from "lucide-preact";
import { syncStatus } from "@glade/app-core/state/sync";
import { hasLocalEnvironment } from "@glade/app-core/state/env-registry";
import { cn } from "@glade/app-core/lib/cn";
import { Button, IconButton, Spinner, TITLEBAR_HEIGHT, TRAFFIC_LIGHTS_WIDTH, formatShortcut } from "@glade/app-core/ui";
import { initError, initialized, loadAll, workspaces, workspacesById } from "@glade/app-core/state/store";
import { resolveSidebarDrag, sidebarCollapsed, sidebarWidth, toggleSidebar, togglePalette } from "@glade/app-core/state/ui";
import { currentWorkspaceId } from "@glade/app-core/state/attention";
import { Sidebar } from "@/features/sidebar";
import { AddProjectHost } from "@/features/projects";
import { rememberAppPath } from "@/features/settings";
import { Palette } from "@/features/palette";
import { globalCommands } from "./commands";
import { useLastRoute } from "./lastRoute";
import { useOpenChatRequests } from "./openChatRequests";
import { useMenuBarActions } from "./menuBarActions";
import { routeContext } from "./paths";
import { SHORTCUTS, useGlobalShortcuts } from "./shortcuts";

function ResizeHandle() {
  const start = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={sidebarWidth.value}
      class="absolute top-0 -right-[3px] bottom-0 z-10 w-[6px] cursor-col-resize"
      onPointerDown={(e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width: sidebarWidth.value };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const { width, collapsed } = resolveSidebarDrag(start.current.width, e.clientX - start.current.x);
        sidebarWidth.value = width;
        sidebarCollapsed.value = collapsed;
      }}
      onPointerUp={() => {
        start.current = null;
        setDragging(false);
      }}
      onDblClick={toggleSidebar}
    >
      {dragging && <div class="fixed inset-0 cursor-col-resize" />}
    </div>
  );
}

/**
 * "Reconnecting…" only after the connection has been down (or still catching up, I-122) for a
 * moment (avoids flashes).
 */
function useDisconnected(delayMs = 1000): boolean {
  // No local environment (a pure client, F-022): each remote one shows its own status.
  const live = syncStatus.value === "live" || !hasLocalEnvironment.value;
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (live) return setLate(false);
    const t = setTimeout(() => setLate(true), delayMs);
    return () => clearTimeout(t);
  }, [live]);
  return !live && late;
}

function StatusBanner() {
  const disconnected = useDisconnected();
  if (initError.value) {
    return (
      <div role="alert" class="flex shrink-0 items-center gap-2 border-b border-separator bg-[color-mix(in_srgb,var(--pi-danger)_10%,transparent)] px-3 py-1.5 text-[0.92rem]">
        <AlertTriangle size={14} class="text-danger" />
        <span class="flex-1">Couldn't load data from the Glade server: {initError.value}</span>
        <Button size="sm" onClick={() => void loadAll()}>
          Retry
        </Button>
      </div>
    );
  }
  if (disconnected) {
    return (
      <div role="status" class="flex shrink-0 items-center gap-2 border-b border-separator bg-[color-mix(in_srgb,var(--pi-warning)_12%,transparent)] px-3 py-1.5 text-[0.92rem]">
        <Spinner size={12} />
        <span>Reconnecting to server…</span>
      </div>
    );
  }
  return null;
}

export function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const collapsed = sidebarCollapsed.value;
  const ctx = routeContext(location.pathname, workspacesById.value);

  useEffect(() => {
    rememberAppPath(location.pathname);
    currentWorkspaceId.value = ctx.workspaceId;
  }, [location.pathname, ctx.workspaceId]);
  useLastRoute();
  useOpenChatRequests();
  useMenuBarActions(
    (path) => void navigate(path),
    () => workspaces.value,
    () => currentWorkspaceId.value,
  );

  const commandContext = { navigate: (path: string) => navigate(path), route: ctx };
  useGlobalShortcuts(globalCommands({ ...commandContext, togglePalette }));

  if (!initialized.value) {
    return (
      <div data-tauri-drag-region class="flex h-full items-center justify-center bg-window">
        <Spinner size={20} />
      </div>
    );
  }

  return (
    <div class="flex h-full min-h-0">
      {!collapsed && (
        <aside
          data-sidebar
          style={{ width: `${sidebarWidth.value}px` }}
          class="relative flex h-full shrink-0 flex-col border-r border-separator bg-sidebar/90 text-sidebar-fg backdrop-blur-2xl"
        >
          <Sidebar />
          <ResizeHandle />
        </aside>
      )}
      <main
        class={cn("relative flex min-w-0 flex-1 flex-col bg-window")}
        style={{ "--pi-main-inset-left": collapsed ? `${TRAFFIC_LIGHTS_WIDTH + 36}px` : "0px" }}
      >
        {collapsed && (
          <div class="absolute z-20 flex items-center" style={{ left: `${TRAFFIC_LIGHTS_WIDTH}px`, top: 0, height: `${TITLEBAR_HEIGHT}px` }}>
            <IconButton size="sm" label={`Show Sidebar (${formatShortcut(SHORTCUTS["toggle-sidebar"])})`} onClick={toggleSidebar}>
              <PanelLeft />
            </IconButton>
          </div>
        )}
        <StatusBanner />
        <div class="min-h-0 flex-1">
          <Outlet />
        </div>
      </main>
      <AddProjectHost />
      <Palette context={commandContext} />
    </div>
  );
}
