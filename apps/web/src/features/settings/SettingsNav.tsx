/**
 * Settings section list shown in the sidebar while the settings screen is open
 * (like System Settings), with a "Back to app" row.
 */
import { useLocation, useNavigate } from "react-router";
import { ChevronLeft } from "lucide-preact";
import { SETTINGS_SECTIONS, routes } from "@/app/routes";
import { SidebarItem } from "@/ui";
import { SECTION_INFO } from "./sections";

/** Where "Back to app" goes: the last non-settings location. */
let lastAppPath = "/";
export function rememberAppPath(path: string): void {
  if (!path.startsWith("/settings")) lastAppPath = path;
}

export function SettingsNav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (
    <div class="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2.5 pb-3">
      <SidebarItem icon={<ChevronLeft />} label="Back to App" onSelect={() => navigate(lastAppPath)} class="mb-2 text-fg-muted" />
      {SETTINGS_SECTIONS.map((section) => {
        const { label, Icon } = SECTION_INFO[section];
        return (
          <SidebarItem
            key={section}
            icon={<Icon />}
            label={label}
            selected={pathname === routes.settings(section)}
            onSelect={() => navigate(routes.settings(section))}
          />
        );
      })}
    </div>
  );
}
