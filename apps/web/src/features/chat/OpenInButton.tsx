/**
 * "Open in VS Code" for a project folder (chat header, project new-chat screen). The targets
 * live in one registry so Finder / Terminal / Cursor can be added next to VS Code (then this
 * becomes a split button with a menu). Failures (e.g. the app isn't installed) show a toast.
 */
import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { SquareCode } from "lucide-preact";
import type { OpenTarget } from "@glade/protocol";
import { api } from "@/lib/api";
import { runAction } from "@/state/chat-session";
import { IconButton } from "@/ui";

export interface OpenTargetInfo {
  label: string;
  icon: ComponentChildren;
}

export const OPEN_TARGETS: Record<OpenTarget, OpenTargetInfo> = {
  vscode: { label: "VS Code", icon: <SquareCode /> },
};

export function OpenInButton({ projectId, target = "vscode" }: { projectId: string; target?: OpenTarget }) {
  const [busy, setBusy] = useState(false);
  const info = OPEN_TARGETS[target];
  const open = async () => {
    setBusy(true);
    await runAction(() => api.openProject(projectId, target), `Could not open in ${info.label}`);
    setBusy(false);
  };
  return (
    <IconButton label={`Open in ${info.label}`} disabled={busy} onClick={() => void open()}>
      {info.icon}
    </IconButton>
  );
}
