/**
 * "Open in VS Code" for a chat's folder (chat header: the workspace's `cwd`, i.e. its worktree
 * or the project folder, I-106) or a project folder (project new-chat screen). The tooltip names
 * the folder ("Open worktree glade/x in VS Code", "Open sample-repo in VS Code"). The targets
 * live in one registry so Finder / Terminal / Cursor can be added next to VS Code (then this
 * becomes a split button with a menu). Failures (e.g. the app isn't installed) show a toast.
 */
import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { SquareCode } from "lucide-preact";
import type { OpenTarget, WorkspaceSummary } from "@glade/protocol";
import { api } from "@/lib/api";
import { runAction } from "@/state/chat-session";
import { projectsById } from "@/state/store";
import { IconButton } from "@/ui";

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
  return projectId ? projectsById.value.get(projectId)?.name : undefined;
}

export function OpenInButton(props: OpenInButtonProps) {
  const { workspace, projectId, target = "vscode" } = props;
  const [busy, setBusy] = useState(false);
  const info = OPEN_TARGETS[target];
  const folder = folderName(props);
  const open = async () => {
    setBusy(true);
    await runAction(
      () => (workspace ? api.openWorkspace(workspace.id, target) : api.openProject(projectId!, target)),
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
