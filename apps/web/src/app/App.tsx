// STUB - owned by the app shell agent (router, layout, sidebar).
import { createBrowserRouter, RouterProvider } from "react-router";
import { TooltipProvider } from "@/ui/Tooltip";

const router = createBrowserRouter([{ path: "*", element: <div class="p-6">pi-ui</div> }]);

export function App() {
  return (
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>
  );
}
