/**
 * The iPhone app's root (I-164): hash router over the phone screens + app-wide hosts. First run
 * (no paired Macs) goes to Connect to a Device.
 */
import { Navigate, RouterProvider, createHashRouter, type RouteObject } from "react-router";
import { ConfirmHost, Toaster, TooltipProvider } from "@/ui";
import { savedEnvironments } from "@/state/saved-environments";
import { ConnectScreen } from "~/screens/ConnectScreen";
import { HomeScreen } from "~/screens/HomeScreen";
import { paths } from "./routes";

function Home() {
  if (savedEnvironments.value.length === 0) return <Navigate to={paths.connect()} replace />;
  return <HomeScreen />;
}

export const iphoneRoutes: RouteObject[] = [
  { path: "/", element: <Home /> },
  { path: "/connect", element: <ConnectScreen /> },
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
