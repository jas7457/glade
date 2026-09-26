/**
 * Root component: router (every screen is a URL, see routes.ts) + app-wide providers and hosts.
 */
import { Navigate, RouterProvider, createBrowserRouter, type RouteObject } from "react-router";
import { ConfirmHost, Toaster, TooltipProvider } from "@/ui";
import { SettingsRoute } from "@/features/settings";
import { Layout } from "./Layout";
import { NotFound } from "./NotFound";
import { ChatRoute, HomeRoute, ProjectRoute } from "./RouteViews";
import { routes } from "./routes";

export const appRoutes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { path: "/", element: <HomeRoute /> },
      { path: "/chats/:chatId", element: <ChatRoute /> },
      { path: "/projects/:projectId", element: <ProjectRoute /> },
      { path: "/projects/:projectId/chats/:chatId", element: <ChatRoute /> },
      { path: "/settings", element: <Navigate to={routes.settings()} replace /> },
      { path: "/settings/:section", element: <SettingsRoute /> },
      { path: "*", element: <NotFound /> },
    ],
  },
];

let router: ReturnType<typeof createBrowserRouter> | null = null;

export function App() {
  router ??= createBrowserRouter(appRoutes);
  return (
    <TooltipProvider>
      <RouterProvider router={router} />
      <ConfirmHost />
      <Toaster />
    </TooltipProvider>
  );
}
