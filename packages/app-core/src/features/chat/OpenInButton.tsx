/**
 * "Open in VS Code" for a chat's folder (chat header: the workspace's `cwd`, i.e. its worktree
 * or the project folder, I-106) or a project folder (project new-chat screen). The tooltip names
 * the folder ("Open worktree glade/x in VS Code", "Open sample-repo in VS Code"). The targets
 * live in one registry so Finder / Terminal / Cursor can be added next to VS Code (then this
 * becomes a split button with a menu). Failures (e.g. the app isn't installed) show a toast.
 * Only shown for chats and projects of this machine (I-123/I-124: a remote host would open the
 * app on *its* screen).
 */
import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { SquareCode } from "lucide-preact";
import type { OpenTarget, WorkspaceSummary } from "@glade/protocol";
import { apiForProject, apiForWorkspace, isThisMachine } from "@glade/app-core/state/env-api";
import { runAction } from "@glade/app-core/state/chat-session";
import { envIdOfProject, envIdOfWorkspace, projectsById } from "@glade/app-core/state/store";
import { IconButton } from "@glade/app-core/ui";

export interface OpenTargetInfo {
  label: string;
  icon: ComponentChildren;
}

export const OPEN_TARGETS: Record<OpenTarget, OpenTargetInfo> = {
  vscode: { label: "VS Code", icon: <SquareCode /> },
};

export type OpenInButtonProps = { target?: OpenTarget } & (
  | { /** A chat: opens its own folder (`workspace.cwd`). */ workspace: WorkspaceSummary; projectId?: undefined }
  | { /** No chat yet: opens the project folder. */ projectId: string; workspace?: undefined }
);

/** What the tooltip calls the folder: the worktree's branch, else the project's name. */
function folderName(props: OpenInButtonProps): string | undefined {
  if (props.workspace?.worktree) return `worktree ${props.workspace.worktree.branch}`;
  const projectId = props.workspace ? props.workspace.projectId : props.projectId;
  const project = projectId ? projectsById.value.get(projectId) : undefined;
  // A group chat (I-213) works in its own folder, not the group's.
  if (props.workspace && project?.path === null) return props.workspace.cwd.replace(/\/+$/, "").split("/").pop() || undefined;
  return project?.name;
}

export function OpenInButton(props: OpenInButtonProps) {
  const { workspace, projectId, target = "vscode" } = props;
  const [busy, setBusy] = useState(false);
  const info = OPEN_TARGETS[target];
  const folder = folderName(props);
  const envId = workspace ? envIdOfWorkspace(workspace.id) : envIdOfProject(projectId);
  if (!isThisMachine(envId, "openIn")) return null;
  const open = async () => {
    setBusy(true);
    await runAction(
      () => (workspace ? apiForWorkspace(workspace.id).openWorkspace(workspace.id, target) : apiForProject(projectId!).openProject(projectId!, target)),
      `Could not open in ${info.label}`,
    );
    setBusy(false);
  };
  return (
    <IconButton label={folder ? `Open ${folder} in ${info.label}` : `Open in ${info.label}`} disabled={busy} onClick={() => void open()}>
      {info.icon}
    </IconButton>
  );
}
