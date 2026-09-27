/**
 * "Commit…" dialog of the changes panel (I-097): a message field, "Generate" (the fast model
 * writes a message from the diff, like chat titles) and Commit. Commits every changed file, or
 * the checked ones when `paths` is given. ⌘Return commits.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { GitCommitHorizontal, Sparkles } from "lucide-preact";
import { notify } from "@/state/toasts";
import { Button, Dialog, Spinner, TextArea } from "@/ui";
import { changesApi } from "./api";

export interface CommitDialogProps {
  workspaceId: string;
  /** Files to commit; `undefined` = all changed files. */
  paths?: string[];
  count: number;
  onClose: () => void;
  onCommitted: () => void;
}

export function CommitDialog({ workspaceId, paths, count, onClose, onCommitted }: CommitDialogProps) {
  const [message, setMessage] = useState("");
  const [generating, setGenerating] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const open = useRef(true);
  useEffect(
    () => () => {
      open.current = false;
    },
    [],
  );

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await changesApi.commitMessage(workspaceId, paths);
      if (!open.current) return;
      setMessage(res.message);
      field.current?.focus();
    } catch (err) {
      if (open.current) setError(`Couldn't write a message: ${(err as Error).message}`);
    } finally {
      if (open.current) setGenerating(false);
    }
  };

  const commit = async () => {
    const text = message.trim();
    if (!text || committing) return;
    setCommitting(true);
    setError(null);
    try {
      const res = await changesApi.commit(workspaceId, text, paths);
      notify("success", `Committed ${res.commit}: ${res.summary}`);
      onCommitted();
    } catch (err) {
      if (open.current) {
        setError((err as Error).message);
        setCommitting(false);
      }
    }
  };

  const files = `${count} ${count === 1 ? "file" : "files"}`;
  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={paths ? `Commit ${files}` : "Commit all changes"}
      description={paths ? "Commits only the checked files." : `Commits all ${files} git sees changed.`}
      icon={<GitCommitHorizontal />}
      width={500}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!message.trim() || committing || generating} onClick={() => void commit()}>
            {committing ? "Committing…" : "Commit"}
          </Button>
        </>
      }
    >
      <div class="flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <label for="commit-message" class="text-[0.92rem] font-medium text-fg-muted">
            Message
          </label>
          <Button size="sm" variant="ghost" disabled={generating || committing} onClick={() => void generate()}>
            {generating ? <Spinner size={12} /> : <Sparkles class="size-3.5" />}
            {generating ? "Writing…" : "Generate"}
          </Button>
        </div>
        <TextArea
          id="commit-message"
          ref={field}
          rows={6}
          mono
          value={message}
          placeholder="Summary of the change"
          spellcheck={false}
          onInput={(e) => setMessage((e.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void commit();
            }
          }}
        />
        {error && <div class="text-[0.92rem] whitespace-pre-wrap text-danger">{error}</div>}
      </div>
    </Dialog>
  );
}
