/**
 * The iPhone app's root (I-164): hash router over the phone screens + app-wide hosts. First run
 * (no paired Macs) goes to Connect to a Device.
 */
import { Navigate, RouterProvider, createHashRouter, type RouteObject } from "react-router";
import { ConfirmHost, Toaster, TooltipProvider } from "@/ui";
import { savedEnvironments } from "@/state/saved-environments";
import { ChatScreen } from "~/screens/ChatScreen";
import { ConnectScreen } from "~/screens/ConnectScreen";
import { DeviceScreen } from "~/screens/DeviceScreen";
import { HomeScreen } from "~/screens/HomeScreen";
import { NewChatScreen } from "~/screens/NewChatScreen";
import { SettingsScreen } from "~/screens/SettingsScreen";
import { paths } from "./routes";

function Home() {
  if (savedEnvironments.value.length === 0) return <Navigate to={paths.connect()} replace />;
  return <HomeScreen />;
}

export const iphoneRoutes: RouteObject[] = [
  { path: "/", element: <Home /> },
  { path: "/connect", element: <ConnectScreen /> },
  { path: "/new", element: <NewChatScreen /> },
  { path: "/e/:envId/chats/:chatId", element: <ChatScreen /> },
  { path: "/settings", element: <SettingsScreen /> },
  { path: "/settings/devices/:envId", element: <DeviceScreen /> },
  { path: "*", element: <Navigate to="/" replace /> },
];

let router: ReturnType<typeof createHashRouter> | null = null;

export function App() {
  router ??= createHashRouter(iphoneRoutes);
  return (
    <TooltipProvider>
      <RouterProvider router={router} />
      <ConfirmHost />
      <Toaster />
    </TooltipProvider>
  );
}
