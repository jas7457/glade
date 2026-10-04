/**
 * The iPhone app's root (I-164): hash router over the phone screens + app-wide hosts. First run
 * (no paired Macs) goes to Connect to a Device.
 */
import { Navigate, RouterProvider, createHashRouter, useParams, useSearchParams, type RouteObject } from "react-router";
import { ConfirmHost, Toaster, TooltipProvider } from "@glade/app-core/ui";
import { connections } from "@glade/app-core/state/env-registry";
import { savedEnvironments } from "@glade/app-core/state/saved-environments";
import { ChatScreen } from "~/screens/ChatScreen";
import { ConnectScreen } from "~/screens/ConnectScreen";
import { DeviceScreen } from "~/screens/DeviceScreen";
import { LocalModelsScreen } from "~/screens/LocalModelsScreen";
import { HomeScreen } from "~/screens/HomeScreen";
import { NewChatScreen } from "~/screens/NewChatScreen";
import { SettingsScreen } from "~/screens/SettingsScreen";
import { VoiceHost } from "~/voice/VoiceHost";
import { VoiceSettingsScreen } from "~/voice/VoiceSettingsScreen";
import { paths } from "./routes";

function Home() {
  if (savedEnvironments.value.length === 0) return <Navigate to={paths.connect()} replace />;
  return <HomeScreen />;
}

/**
 * Shared web code navigates with the desktop's paths (`chatPath`: `/e/:env/projects/:pid/chats/:id`,
 * `/chats/:id`); send them to the phone's chat screen.
 */
function DesktopChatRedirect() {
  const { envId, chatId = "" } = useParams();
  const [search] = useSearchParams();
  const env = envId ?? connectionsFirstId();
  return <Navigate to={env ? paths.chat(env, chatId, search.get("tab")) : paths.home()} replace />;
}

function connectionsFirstId(): string | null {
  return connections.value[0]?.id ?? null;
}

export const iphoneRoutes: RouteObject[] = [
  { path: "/", element: <Home /> },
  { path: "/connect", element: <ConnectScreen /> },
  { path: "/new", element: <NewChatScreen /> },
  { path: "/e/:envId/chats/:chatId", element: <ChatScreen /> },
  { path: "/e/:envId/projects/:projectId/chats/:chatId", element: <DesktopChatRedirect /> },
  { path: "/projects/:projectId/chats/:chatId", element: <DesktopChatRedirect /> },
  { path: "/chats/:chatId", element: <DesktopChatRedirect /> },
  { path: "/settings", element: <SettingsScreen /> },
  { path: "/settings/devices/:envId", element: <DeviceScreen /> },
  { path: "/settings/devices/:envId/local-models", element: <LocalModelsScreen /> },
  { path: "/settings/voice", element: <VoiceSettingsScreen /> },
  { path: "*", element: <Navigate to="/" replace /> },
];

let router: ReturnType<typeof createHashRouter> | null = null;

export function App() {
  router ??= createHashRouter(iphoneRoutes);
  return (
    <TooltipProvider>
      <RouterProvider router={router} />
      <VoiceHost />
      <ConfirmHost />
      <Toaster />
    </TooltipProvider>
  );
}
