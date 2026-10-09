/**
 * The folder picked for a new chat in a **group project** (I-213: a project with `path: null`
 * whose chats each choose their own folder at creation; the folder is fixed afterwards).
 *
 * Like the worktree choice (`worktrees.ts`) it remembers nothing between chats: `newChatFolder`
 * holds the folder for one project, set by the new-chat screen's folder picker (desktop context
 * bar, iPhone folder row), cleared when the new-chat screen goes away and after the chat is
 * created. `createWorkspace` asks `folderRequestFor` what to send; the composer won't send while
 * `needsNewChatFolder` is true.
 */
import { signal } from "@preact/signals";
import type { CreateWorkspaceRequest, Project } from "@glade/protocol";

/** The folder chosen for a new chat in a group project, or null. */
export const newChatFolder = signal<{ projectId: string; path: string } | null>(null);

/** Whether a project is a group project (no folder of its own; I-213). */
export function isGroupProject(project: Pick<Project, "path"> | null | undefined): boolean {
  return !!project && project.path === null;
}

/** Set (or clear, with null) the new chat's folder for `projectId`. */
export function setNewChatFolder(projectId: string, path: string | null): void {
  newChatFolder.value = path ? { projectId, path } : null;
}

/** The folder chosen for `projectId`'s new chat, or null. */
export function newChatFolderFor(projectId: string | null): string | null {
  const current = newChatFolder.value;
  return projectId !== null && current?.projectId === projectId ? current.path : null;
}

/** Forget the choice (the new-chat screen went away or the chat was created). */
export function resetNewChatFolder(): void {
  newChatFolder.value = null;
}

/** True while a new chat in this (group) project can't be sent yet: no folder chosen. */
export function needsNewChatFolder(project: Pick<Project, "id" | "path"> | null | undefined): boolean {
  return isGroupProject(project) && newChatFolderFor(project!.id) === null;
}

/** The `folder` field of a new chat's `CreateWorkspaceRequest` for the current choice. */
export function folderRequestFor(projectId: string | null): Pick<CreateWorkspaceRequest, "folder"> {
  const path = newChatFolderFor(projectId);
  return path ? { folder: path } : {};
}
