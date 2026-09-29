/**
 * Context bar: which project the new chat goes to (I-105). Search, the projects (✓ current),
 * "Add Project…" (the usual add-project dialog) and "No Project" (a standalone chat). Picking one
 * opens that project's new-chat screen.
 */
import { useNavigate } from "react-router";
import { ChevronDown, Folder, FolderPlus, MessageSquare } from "lucide-preact";
import { routes } from "@glade/app-core/app/routes";
import { envIdOf, projectsById, sortedProjects } from "@glade/app-core/state/store";
import { environmentLabel, isLocalEnvironment } from "@glade/app-core/state/env-registry";
import { openAddProject } from "@glade/app-core/state/ui";
import { SearchPopover } from "@glade/app-core/ui";
import { barButtonClass } from "./shared";

const ADD = "\0add";
const NONE = "\0none";

export function ProjectPicker({ projectId }: { projectId: string | null }) {
  const navigate = useNavigate();
  const project = projectId ? projectsById.value.get(projectId) : undefined;
  const onSelect = (id: string) => {
    if (id === ADD) openAddProject();
    else if (id === NONE) navigate(routes.home());
    else if (id !== projectId) navigate(routes.project(id));
  };
  return (
    <SearchPopover
      label="Projects"
      placeholder="Search projects"
      side="top"
      onSelect={onSelect}
      sections={[
        {
          items: sortedProjects.value.map((p) => {
            // Projects of another environment say where they are (I-123).
            const env = envIdOf(p);
            const remote = isLocalEnvironment(env) ? undefined : environmentLabel(env);
            return { id: p.id, label: p.name, checked: p.id === projectId, keywords: remote ? [p.path, remote] : [p.path], detail: remote };
          }),
        },
        {
          items: [
            { id: ADD, label: "Add Project…", icon: <FolderPlus />, persistent: true },
            { id: NONE, label: "No Project", icon: <MessageSquare />, checked: projectId === null, persistent: true },
          ],
        },
      ]}
      trigger={
        <button type="button" class={barButtonClass} aria-label={`Project: ${project?.name ?? "none"}`} title={project?.path ?? "Standalone chat in a scratch folder"}>
          {project ? <Folder /> : <MessageSquare />}
          <span class="truncate">{project?.name ?? "No project"}</span>
          <ChevronDown size={10} strokeWidth={2.5} class="opacity-60" />
        </button>
      }
    />
  );
}
