/**
 * "Commit your changes to switch branch" (I-105): switching the project folder to another branch
 * is refused while it has uncommitted changes (user decision). Lists the files and offers
 * "Commit…" (the changes panel's commit dialog, in the project folder); after a successful commit
 * it switches.
 */
import { useState } from "preact/hooks";
import { GitBranch } from "lucide-preact";
import type { ProjectGitInfo } from "@glade/protocol";
import { CommitDialog } from "@/features/changes/CommitDialog";
import { Button, Dialog } from "@/ui";
import { plural } from "./shared";

const SHOWN = 6;

export interface SwitchBranchDialogProps {
  projectId: string;
  /** The branch the user picked. */
  branch: string;
  git: ProjectGitInfo;
  onClose: () => void;
  /** Runs the checkout once the commit went through. */
  onCommitted: () => void;
}

export function SwitchBranchDialog({ projectId, branch, git, onClose, onCommitted }: SwitchBranchDialogProps) {
  const [committing, setCommitting] = useState(false);
  const count = git.uncommittedFiles;
  const files = plural(count, "uncommitted file");

  if (committing) {
    return (
      <CommitDialog
        projectId={projectId}
        count={count}
        description={`Commits all ${files} in the project folder, then switches to ${branch}.`}
        onClose={onClose}
        onCommitted={onCommitted}
      />
    );
  }
  const shown = git.uncommittedPaths.slice(0, SHOWN);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Commit your changes to switch branch"
      description={`The project folder has ${files}${git.branch ? ` on ${git.branch}` : ""}. Commit them first, then Glade switches it to ${branch}.`}
      icon={<GitBranch />}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" autoFocus onClick={() => setCommitting(true)}>
            Commit…
          </Button>
        </>
      }
    >
      <ul aria-label="Uncommitted files" class="flex flex-col gap-0.5 rounded-[6px] bg-tabbar px-2.5 py-1.5 font-mono ring-1 ring-separator text-[0.88rem] text-fg-muted">
        {shown.map((path) => (
          <li key={path} class="truncate" title={path}>
            {path}
          </li>
        ))}
        {count > shown.length && <li class="font-sans text-fg-subtle">and {count - shown.length} more</li>}
      </ul>
    </Dialog>
  );
}
