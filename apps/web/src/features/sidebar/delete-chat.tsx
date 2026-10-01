/**
 * Deleting a chat (workspace), from the sidebar, the palette or its last tab. Normal chats get
 * the plain confirm; a chat working in its own git worktree (I-096) gets a dialog that shows
 * the branch's state (uncommitted files, commits not in the base) and asks what to do with it:
 * Keep branch (default), Merge into <base>, or Discard.
 *
 *   if (await confirmDeleteChat(chat)) navigate(…);   // needs <DeleteChatHost /> mounted once
 */
import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import type { WorkspaceSummary, WorkspaceWorktree, WorktreeRemoval, WorktreeStatus } from "@glade/protocol";
import { apiForWorkspace } from "@glade/app-core/state/env-api";
import { Button, Dialog, SegmentedControl, Spinner, confirm, shortenSubject } from "@glade/app-core/ui";
import { deleteWorkspace } from "@glade/app-core/state/actions";
import { busyTerminalPrograms, terminatingNote } from "@/features/terminal/close-confirm";
import { terminalsOf } from "@/features/workspace/layout";

export interface DeleteChatOptions {
  /** Text after the quoted title (default "will be permanently deleted. This can't be undone."). */
  message?: string;
  /** Default "Delete". */
  confirmLabel?: string;
}

const DEFAULT_MESSAGE = "will be permanently deleted. This can't be undone.";

interface Pending {
  chat: WorkspaceSummary & { worktree: WorkspaceWorktree };
  options: DeleteChatOptions;
  resolve: (choice: WorktreeRemoval | null) => void;
}

const pending = signal<Pending | null>(null);

/**
 * Ask, then delete the chat. Resolves `true` once it's deleted. The dialog also names programs
 * its terminal tabs are running, which deleting terminates (I-192).
 */
export async function confirmDeleteChat(chat: WorkspaceSummary, options: DeleteChatOptions = {}): Promise<boolean> {
  const { worktree } = chat;
  const programs = terminalsOf(chat.layout).length ? await busyTerminalPrograms(chat.id) : [];
  if (programs.length) options = { ...options, message: `${options.message ?? DEFAULT_MESSAGE} ${terminatingNote(programs)}` };
  if (!worktree) {
    const ok = await confirm({
      title: "Delete chat?",
      subject: chat.title || "Untitled",
      message: options.message ?? DEFAULT_MESSAGE,
      confirmLabel: options.confirmLabel ?? "Delete",
      destructive: true,
    });
    return ok && deleteWorkspace(chat.id);
  }
  pending.value?.resolve(null);
  const choice = await new Promise<WorktreeRemoval | null>((resolve) => {
    pending.value = { chat: { ...chat, worktree }, options, resolve };
  });
  return choice !== null && deleteWorkspace(chat.id, choice);
}

/** Renders the pending worktree delete dialog. Mount once at the app root. */
export function DeleteChatHost() {
  const current = pending.value;
  if (!current) return null;
  const settle = (choice: WorktreeRemoval | null) => {
    if (pending.value === current) pending.value = null;
    current.resolve(choice);
  };
  return <DeleteWorktreeChatDialog key={current.chat.id} chat={current.chat} options={current.options} onResult={settle} />;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface DeleteWorktreeChatDialogProps {
  chat: WorkspaceSummary & { worktree: WorkspaceWorktree };
  options?: DeleteChatOptions;
  onResult: (choice: WorktreeRemoval | null) => void;
}

export function DeleteWorktreeChatDialog({ chat, options = {}, onResult }: DeleteWorktreeChatDialogProps) {
  const { branch, baseRef } = chat.worktree;
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [choice, setChoice] = useState<WorktreeRemoval>("keep");

  useEffect(() => {
    let live = true;
    apiForWorkspace(chat.id).getWorktreeStatus(chat.id).then(
      (s) => live && setStatus(s),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [chat.id]);

  const blocker = status?.mergeBlocker ?? null;
  const ahead = status?.ahead ?? 0;
  const dirty = status?.uncommittedFiles ?? 0;
  const explanation =
    choice === "keep"
      ? `Removes the worktree folder. The branch ${branch} stays in the repository.`
      : choice === "merge"
        ? `Merges ${branch} into ${baseRef} in the project folder, then deletes the branch.`
        : `Deletes the worktree folder and the branch ${branch}${ahead ? `, including ${plural(ahead, "commit")} not in ${baseRef}` : ""}.`;

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onResult(null)}
      width={440}
      title="Delete chat?"
      description={
        <>
          <span class="font-medium text-fg-strong">“{shortenSubject(chat.title || "Untitled")}”</span> {options.message ?? DEFAULT_MESSAGE} It works in
          its own worktree on <span class="font-mono text-[0.92em] text-fg">{branch}</span>.
        </>
      }
      footer={
        <>
          <Button onClick={() => onResult(null)}>Cancel</Button>
          <Button data-default variant="danger" disabled={choice === "merge" && (!status || !!blocker)} onClick={() => onResult(choice)}>
            {options.confirmLabel ?? "Delete"}
          </Button>
        </>
      }
    >
      <div class="flex flex-col gap-3">
        <div class="flex min-h-[18px] items-center gap-2 text-[0.92rem] text-fg-muted" data-testid="worktree-status">
          {status ? (
            <span>
              {dirty ? <span class="text-warning">{plural(dirty, "uncommitted file")} (will be lost)</span> : "No uncommitted changes"}
              {" · "}
              {ahead ? `${plural(ahead, "commit")} not in ${baseRef}` : `nothing new since ${baseRef}`}
            </span>
          ) : failed ? (
            <span>Couldn't read the branch's state.</span>
          ) : (
            <>
              <Spinner size={12} /> Checking the branch…
            </>
          )}
        </div>
        <SegmentedControl<WorktreeRemoval>
          fill
          aria-label="What to do with the branch"
          value={choice}
          onChange={setChoice}
          options={[
            { value: "keep", label: "Keep branch" },
            { value: "merge", label: `Merge into ${baseRef}`, disabled: !!blocker, title: blocker ?? undefined },
            { value: "discard", label: "Discard" },
          ]}
        />
        <p class="text-[0.92rem] leading-relaxed text-fg-muted">{choice === "merge" && blocker ? blocker : explanation}</p>
        {choice === "merge" || !blocker ? null : (
          <p class="text-[0.92rem] leading-relaxed text-fg-subtle">Merge isn't available: {blocker}</p>
        )}
      </div>
    </Dialog>
  );
}
