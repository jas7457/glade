/**
 * The icon of a project wherever projects are listed (sidebar, project picker, palette): a folder
 * (open while its group is expanded), or stacked layers for a **group project** (I-213: no folder
 * of its own, `path: null`; each of its chats picks a folder).
 *
 *   <ProjectIcon project={p} open={expanded} />
 */
import { Folder, FolderOpen, Layers } from "lucide-preact";
import type { Project } from "@glade/protocol";

export interface ProjectIconProps {
  project: Pick<Project, "path"> | null | undefined;
  /** Show the open folder (sidebar: the project's chats are expanded). Groups ignore it. */
  open?: boolean;
  size?: number;
  class?: string;
}

export function ProjectIcon({ project, open = false, size, class: className }: ProjectIconProps) {
  const Icon = project?.path === null ? Layers : open ? FolderOpen : Folder;
  return <Icon size={size} class={className} aria-hidden data-icon={project?.path === null ? "group" : "folder"} />;
}
