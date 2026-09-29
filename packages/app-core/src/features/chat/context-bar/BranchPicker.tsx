/**
 * Context bar: the branch (I-105, git projects).
 * - Local: shows the project folder's branch; picking another checks it out there — refused
 *   while the folder has uncommitted changes ("Commit your changes to switch branch", with a
 *   Commit… button) or while a chat works in the folder. "New branch…" creates one and switches.
 * - New worktree: picks the branch the worktree starts from (nothing is checked out);
 *   "Name New Branch…" names the worktree's branch. From the folder's current branch with
 *   uncommitted files, "Bring my uncommitted changes (N files)" toggles copying them into the
 *   worktree (I-117; off by default, the folder keeps its copy).
 */
import { useState } from "preact/hooks";
import { ChevronDown, GitBranch, GitBranchPlus } from "lucide-preact";
import type { ProjectGitInfo } from "@glade/protocol";
import { ApiRequestError } from "@glade/app-core/lib/api";
import { notify } from "@glade/app-core/state/toasts";
import {
  canCarryChanges,
  checkoutProjectBranch,
  loadProjectGit,
  newChatWorktree,
  newChatWorktreeOptions,
  projectGit,
  setWorktreeOptions,
} from "@glade/app-core/state/worktrees";
import { SearchPopover, type SearchPopoverItem } from "@glade/app-core/ui";
import { NewBranchDialog } from "./NewBranchDialog";
import { SwitchBranchDialog } from "./SwitchBranchDialog";
import { barButtonClass, chatNames, localRunningChats, plural } from "./shared";

const NEW = "\0new";
const CARRY = "\0carry";

type Pending = { kind: "dirty"; branch: string; git: ProjectGitInfo } | { kind: "new"; initial: string } | null;

export function BranchPicker({ projectId, git }: { projectId: string; git: ProjectGitInfo }) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const worktree = newChatWorktree.value === projectId;
  const opts = newChatWorktreeOptions.value?.projectId === projectId ? newChatWorktreeOptions.value : null;
  const base = opts?.baseRef ?? git.branch;
  const running = worktree ? [] : localRunningChats(projectId);
  const dirty = git.uncommittedFiles;
  const canCarry = worktree && canCarryChanges(git, opts?.baseRef);
  const carry = canCarry && !!opts?.carryChanges;

  const checkout = async (branch: string) => {
    try {
      await checkoutProjectBranch(projectId, branch);
    } catch (err) {
      await loadProjectGit(projectId);
      const fresh = projectGit.value.get(projectId);
      // Changed since we last looked: show the commit dialog instead of a bare error.
      if (err instanceof ApiRequestError && err.status === 409 && fresh && fresh.uncommittedFiles > 0) setPending({ kind: "dirty", branch, git: fresh });
      else notify("error", `Couldn't switch to ${branch}: ${(err as Error).message}`);
    }
  };

  const onSelect = (id: string) => {
    if (id === NEW) {
      const exact = git.branches.some((b) => b.name === query.trim());
      setPending({ kind: "new", initial: exact ? "" : query.trim() || (worktree ? (opts?.branch ?? "") : "") });
      return;
    }
    if (id === CARRY) return setWorktreeOptions(projectId, { carryChanges: !carry });
    if (worktree) return setWorktreeOptions(projectId, { baseRef: id === git.branch ? null : id });
    if (id === git.branch) return;
    if (dirty > 0) setPending({ kind: "dirty", branch: id, git });
    else void checkout(id);
  };

  const items: SearchPopoverItem[] = git.branches.map((b) => ({
    id: b.name,
    label: b.name,
    checked: worktree ? b.name === base : b.current,
    disabled: !worktree && running.length > 0 && !b.current,
    detail: b.current && dirty > 0 ? `${plural(dirty, "uncommitted file")}${worktree ? (carry ? " (brought along)" : " (stay in the project folder)") : ""}` : undefined,
  }));
  const typed = query.trim();
  const newLabel = worktree
    ? typed && !git.branches.some((b) => b.name === typed) ? `Name New Branch “${typed}”…` : "Name New Branch…"
    : typed && !git.branches.some((b) => b.name === typed) ? `New Branch “${typed}”…` : "New Branch…";

  const label = worktree ? (opts?.branch ? `${opts.branch}` : `from ${base ?? "HEAD"}`) : (git.branch ?? "Detached HEAD");
  const title = worktree
    ? `The new worktree ${opts?.branch ? `works on ${opts.branch}, ` : ""}starts from ${base ?? "the current commit"}${carry ? ` with your ${plural(dirty, "uncommitted file")}` : ""}`
    : `The project folder is on ${git.branch ?? "a detached HEAD"}`;

  return (
    <>
      <SearchPopover
        label="Branches"
        placeholder="Search branches"
        side="top"
        width={300}
        onQueryChange={setQuery}
        onOpenChange={(open) => open && void loadProjectGit(projectId)}
        onSelect={onSelect}
        notice={
          worktree ? (
            "Start the worktree from:"
          ) : running.length > 0 ? (
            <>
              {chatNames(running)} {running.length === 1 ? "is" : "are"} working in the project folder. Switch branch when {running.length === 1 ? "it's" : "they're"} done.
            </>
          ) : undefined
        }
        sections={[
          { items },
          ...(canCarry
            ? [
                {
                  items: [
                    {
                      id: CARRY,
                      label: `Bring my uncommitted changes (${plural(dirty, "file")})`,
                      detail: "The project folder keeps its copy",
                      checked: carry,
                      persistent: true,
                    },
                  ],
                },
              ]
            : []),
          { items: [{ id: NEW, label: newLabel, icon: <GitBranchPlus />, persistent: true, disabled: !worktree && running.length > 0 }] },
        ]}
        trigger={
          <button type="button" class={barButtonClass} aria-label={`Branch: ${label}${carry ? `, with ${plural(dirty, "uncommitted file")}` : ""}`} title={title}>
            <GitBranch />
            {worktree && opts?.branch && <span class="shrink-0 text-fg-subtle">from {base} →</span>}
            <span class="truncate">{label}</span>
            {carry && <span class="shrink-0 text-fg-subtle">+ {plural(dirty, "change")}</span>}
            {!worktree && dirty > 0 && (
              <span class="shrink-0 text-fg-subtle" title={plural(dirty, "uncommitted file")}>
                · {dirty}
              </span>
            )}
            <ChevronDown size={10} strokeWidth={2.5} class="opacity-60" />
          </button>
        }
      />
      {pending?.kind === "dirty" && (
        <SwitchBranchDialog
          projectId={projectId}
          branch={pending.branch}
          git={pending.git}
          onClose={() => setPending(null)}
          onCommitted={() => {
            setPending(null);
            void checkout(pending.branch);
          }}
        />
      )}
      {pending?.kind === "new" && (
        <NewBranchDialog
          projectId={projectId}
          mode={worktree ? "worktree" : "local"}
          from={worktree ? base : git.branch}
          initial={pending.initial}
          onClose={() => setPending(null)}
          onNamed={(name) => setWorktreeOptions(projectId, { branch: name || null })}
        />
      )}
    </>
  );
}
