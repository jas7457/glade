/**
 * Root component: router (every screen is a URL, see routes.ts) + app-wide providers and hosts.
 */
import { RouterProvider, createBrowserRouter, type RouteObject } from "react-router";
import { ConfirmHost, Toaster, TooltipProvider } from "@/ui";
import { PairRoute, PendingPairingHost } from "@/features/environments";
import { SettingsIndexRoute, SettingsRoute } from "@/features/settings";
import { DeleteChatHost } from "@/features/sidebar";
import { Layout } from "./Layout";
import { NotFound } from "./NotFound";
import { ChatRoute, HomeRoute, ProjectRoute } from "./RouteViews";

export const appRoutes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { path: "/", element: <HomeRoute /> },
      { path: "/chats/:chatId", element: <ChatRoute /> },
      { path: "/projects/:projectId", element: <ProjectRoute /> },
      { path: "/projects/:projectId/chats/:chatId", element: <ChatRoute /> },
      // Another environment's screens (I-123); the ones above are the local environment's.
      { path: "/e/:envId", element: <HomeRoute /> },
      { path: "/e/:envId/chats/:chatId", element: <ChatRoute /> },
      { path: "/e/:envId/projects/:projectId", element: <ProjectRoute /> },
      { path: "/e/:envId/projects/:projectId/chats/:chatId", element: <ChatRoute /> },
      // A pairing link for this device (I-126): `/pair?link=glade://pair…`.
      { path: "/pair", element: <PairRoute /> },
      { path: "/settings", element: <SettingsIndexRoute /> },
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
      <DeleteChatHost />
      <PendingPairingHost />
      <Toaster />
    </TooltipProvider>
  );
}
