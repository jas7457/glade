/**
 * Settings section list shown in the sidebar while the settings screen is open
 * (like System Settings): a "Back to App" row, then the sections grouped by category
 * (`SETTINGS_GROUPS`).
 */
import { useLocation, useNavigate } from "react-router";
import { ChevronLeft } from "lucide-preact";
import { routes } from "@/app/routes";
import { cn } from "@/lib/cn";
import { SidebarGroup, SidebarItem, SidebarList, sidebarClass } from "@/ui";
import { SECTION_INFO, SETTINGS_GROUPS } from "./sections";

/** Where "Back to app" goes: the last non-settings location. */
let lastAppPath = "/";
export function rememberAppPath(path: string): void {
  if (!path.startsWith("/settings")) lastAppPath = path;
}

export function SettingsNav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (
    <div class={cn("min-h-0 flex-1 overflow-y-auto pb-3", sidebarClass.paddingX)}>
      <SidebarList>
        <SidebarItem icon={<ChevronLeft />} label="Back to App" onSelect={() => navigate(lastAppPath)} class="text-fg-muted" />
      </SidebarList>
      {SETTINGS_GROUPS.map((group) => (
        <SidebarGroup key={group.title} title={group.title}>
          <SidebarList>
            {group.sections.map((section) => {
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
          </SidebarList>
        </SidebarGroup>
      ))}
    </div>
  );
}
