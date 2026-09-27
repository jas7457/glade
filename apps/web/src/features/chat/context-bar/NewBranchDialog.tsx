/**
 * "New branch…" from the context bar's branch picker (I-105).
 * - Local: creates the branch from the current one and switches the project folder to it
 *   (uncommitted changes come along, nothing in the folder changes).
 * - Worktree: names the new worktree's branch (empty = the default `glade/<chat name>`); the
 *   server checks the name when the chat is created.
 */
import { useState } from "preact/hooks";
import { GitBranchPlus } from "lucide-preact";
import { createProjectBranch } from "@/state/worktrees";
import { Button, Dialog, TextField } from "@/ui";

export interface NewBranchDialogProps {
  projectId: string;
  mode: "local" | "worktree";
  /** Local: the current branch; worktree: the base branch. */
  from: string | null;
  initial: string;
  onClose: () => void;
  /** Worktree mode: the chosen name ("" = default). */
  onNamed?: (name: string) => void;
}

/** Obvious mistakes, caught before asking git (which has the final word). */
export function branchNameProblem(name: string): string | null {
  if (/\s/.test(name)) return "Branch names can't contain spaces";
  if (name.startsWith("-")) return "Branch names can't start with “-”";
  if (/\.\.|[~^:?*[\\]|@\{|\/\/|\/$|\.$|\.lock$/.test(name)) return "That isn't a valid branch name";
  return null;
}

export function NewBranchDialog({ projectId, mode, from, initial, onClose, onNamed }: NewBranchDialogProps) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  const problem = trimmed ? branchNameProblem(trimmed) : null;
  const local = mode === "local";

  const submit = async () => {
    if (problem || busy || (local && !trimmed)) return;
    if (!local) {
      onNamed?.(trimmed);
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createProjectBranch(projectId, trimmed, true);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={local ? "New branch" : "Name the worktree's branch"}
      description={
        local
          ? `Creates the branch from ${from ?? "the current commit"} and switches the project folder to it. Uncommitted changes come along.`
          : `The new chat's worktree works on this branch, starting from ${from ?? "the current branch"}. Leave it empty to name it after the chat (glade/…).`
      }
      icon={<GitBranchPlus />}
      width={440}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!!problem || busy || (local && !trimmed)} onClick={() => void submit()}>
            {local ? (busy ? "Creating…" : "Create and Switch") : "Use Name"}
          </Button>
        </>
      }
    >
      <div class="flex flex-col gap-1.5">
        <TextField
          autoFocus
          mono
          aria-label="Branch name"
          placeholder={local ? "feature/my-change" : "glade/<chat name>"}
          value={name}
          invalid={!!problem || !!error}
          onInput={(e) => {
            setName((e.currentTarget as HTMLInputElement).value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {(problem || error) && <div class="text-[0.92rem] text-danger">{problem ?? error}</div>}
      </div>
    </Dialog>
  );
}
