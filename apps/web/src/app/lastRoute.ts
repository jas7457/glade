/**
 * Reopen the last screen (I-083): every navigation is remembered in localStorage (`state/ui.ts`),
 * and when the app first loads at `/` the previous route is restored if its chat/project still
 * exists. An explicit non-root URL (a link, a refresh elsewhere) always wins.
 *
 * I-123: the stored route names its environment (`/e/:envId/…`, none = local), so the one
 * remembered screen is environment-scoped; another environment's route is restored while that
 * environment is connected (its lists may still be loading; the route view waits for them).
 */
import { useEffect } from "preact/hooks";
import { matchPath, useLocation, useNavigate } from "react-router";
import type { Project, WorkspaceSummary } from "@glade/protocol";
import { connectionFor, isLocalEnvironment } from "@glade/app-core/state/env-registry";
import { initialized, projectsById, workspacesById } from "@glade/app-core/state/store";
import { previousRoute, rememberRoute } from "@glade/app-core/state/ui";
import { SETTINGS_SECTIONS, parseEnvPath } from "@glade/app-core/app/routes";

export interface RouteData {
  workspacesById: ReadonlyMap<string, WorkspaceSummary>;
  projectsById: ReadonlyMap<string, Project>;
  /** Whether another environment is connected (I-123); default: never. */
  hasEnvironment?: (envId: string) => boolean;
}

/** `stored` if it points at something that still exists (other than home), else null. */
export function restorableRoute(stored: string | null, data: RouteData): string | null {
  if (!stored || !stored.startsWith("/")) return null;
  const { envId, path: pathname } = parseEnvPath(stored.split(/[?#]/)[0]!);
  if (envId && !isLocalEnvironment(envId)) return data.hasEnvironment?.(envId) && pathname !== "/" ? stored : null;
  const projectChat = matchPath("/projects/:projectId/chats/:chatId", pathname);
  if (projectChat) return data.workspacesById.has(projectChat.params.chatId!) ? stored : null;
  const chat = matchPath("/chats/:chatId", pathname);
  if (chat) return data.workspacesById.has(chat.params.chatId!) ? stored : null;
  const project = matchPath("/projects/:projectId", pathname);
  if (project) return data.projectsById.has(project.params.projectId!) ? stored : null;
  const settings = matchPath("/settings/:section", pathname);
  if (settings) return (SETTINGS_SECTIONS as readonly string[]).includes(settings.params.section!) ? stored : null;
  return null;
}

/** Where to go on startup: the stored route, only when the page was opened at plain `/`. */
export function startupRoute(initialUrl: string, stored: string | null, data: RouteData): string | null {
  if (initialUrl !== "/") return null;
  return restorableRoute(stored, data);
}

/** URL this page load started at (captured before the router can change it). */
const initialUrl = typeof window === "undefined" ? "/" : window.location.pathname + window.location.search;
let restoreChecked = false;

/** Test hook: forget that this page load already decided about restoring. */
export function resetLastRouteForTests(): void {
  restoreChecked = false;
}

/** Restores the last route once data is loaded, then remembers every navigation. */
export function useLastRoute(options: { initialUrl?: string; stored?: string | null } = {}): void {
  const location = useLocation();
  const navigate = useNavigate();
  const ready = initialized.value;
  const route = location.pathname + location.search;
  useEffect(() => {
    if (!ready) return;
    if (!restoreChecked) {
      restoreChecked = true;
      const to = startupRoute(options.initialUrl ?? initialUrl, options.stored === undefined ? previousRoute : options.stored, {
        workspacesById: workspacesById.value,
        projectsById: projectsById.value,
        hasEnvironment: (id) => !!connectionFor(id),
      });
      if (to && to !== route) {
        void navigate(to, { replace: true });
        return;
      }
    }
    rememberRoute(route);
  }, [ready, route]);
}
