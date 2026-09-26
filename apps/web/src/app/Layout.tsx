/**
 * App layout route: resizable/collapsible sidebar + main pane (<Outlet/>), status banners,
 * global shortcuts, the command palette and dialogs hosted at the root.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { Outlet, useLocation, useNavigate } from "react-router";
import { AlertTriangle, PanelLeft } from "lucide-preact";
import { connectionStatus } from "@/lib/socket";
import { cn } from "@/lib/cn";
import { Button, IconButton, Spinner, TITLEBAR_HEIGHT, TRAFFIC_LIGHTS_WIDTH, formatShortcut } from "@/ui";
import { chatsById, initError, initialized, loadAll } from "@/state/store";
import { resolveSidebarDrag, sidebarCollapsed, sidebarWidth, toggleSidebar, togglePalette } from "@/state/ui";
import { currentChatId } from "@/state/attention";
import { Sidebar } from "@/features/sidebar";
import { AddProjectHost } from "@/features/projects";
import { rememberAppPath } from "@/features/settings";
import { Palette } from "@/features/palette";
import { globalCommands } from "./commands";
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

/** "Reconnecting…" only after the socket has been down for a moment (avoids flashes). */
function useDisconnected(delayMs = 1000): boolean {
  const status = connectionStatus.value;
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (status === "open") return setLate(false);
    const t = setTimeout(() => setLate(true), delayMs);
    return () => clearTimeout(t);
  }, [status === "open"]);
  return status !== "open" && late;
}

function StatusBanner() {
  const disconnected = useDisconnected();
  if (initError.value) {
    return (
      <div role="alert" class="flex shrink-0 items-center gap-2 border-b border-separator bg-[color-mix(in_srgb,var(--pi-danger)_10%,transparent)] px-3 py-1.5 text-[0.92rem]">
        <AlertTriangle size={14} class="text-danger" />
        <span class="flex-1">Couldn't load data from the pi-ui server: {initError.value}</span>
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
  const ctx = routeContext(location.pathname, chatsById.value);

  useEffect(() => {
    rememberAppPath(location.pathname);
    currentChatId.value = ctx.chatId;
  }, [location.pathname, ctx.chatId]);

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
