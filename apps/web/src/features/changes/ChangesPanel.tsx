/**
 * Changes panel (I-097): every file git sees changed in the chat's folder (whoever changed it),
 * with +/− counts. A row expands to its diff (the chat's `DiffView`); its ↶ button discards the
 * change after a confirm. Checkboxes pick what "Commit…" commits (all by default). Files this
 * chat's agents edited get a small dot (a hint, from the loaded transcripts).
 *
 * Shown in the workspace's right pane (WorkspaceView); the header's changes button toggles it.
 * Refreshes when it opens, when a run ends (changes-state) and with its refresh button.
 */
import { useEffect, useMemo, useState } from "preact/hooks";
import { ChevronRight, GitBranch, PanelRightClose, RefreshCw, Undo2 } from "lucide-preact";
import type { GitChangedFile, GitChangeKind, GitFileDiffResponse } from "@glade/protocol";
import { cn } from "@/lib/cn";
import { getChatSession } from "@/state/chat-session";
import { sessions } from "@/state/store";
import { notify } from "@/state/toasts";
import { Button, Checkbox, IconButton, Spinner, TAB_STRIP_HEIGHT, confirm } from "@/ui";
import { DiffView } from "@/features/chat/tools/renderers";
import { agentEditedPaths } from "./agent-edits";
import { changesApi } from "./api";
import { changesEntry, refreshChanges, setChanges } from "./changes-state";
import { CommitDialog } from "./CommitDialog";

export interface ChangesPanelProps {
  workspaceId: string;
  /** The workspace folder (to match the agent's tool paths). */
  cwd: string;
  onClose: () => void;
}

const KIND: Record<GitChangeKind, { letter: string; label: string; class: string }> = {
  modified: { letter: "M", label: "Modified", class: "text-warning" },
  added: { letter: "A", label: "Added", class: "text-success" },
  untracked: { letter: "U", label: "Untracked (new)", class: "text-success" },
  deleted: { letter: "D", label: "Deleted", class: "text-danger" },
  renamed: { letter: "R", label: "Renamed", class: "text-accent" },
  conflicted: { letter: "!", label: "Conflicted", class: "text-danger" },
};

export function ChangesPanel({ workspaceId, cwd, onClose }: ChangesPanelProps) {
  const entry = changesEntry(workspaceId);
  const status = entry.status.value;
  const loading = entry.loading.value;
  const version = entry.version.value;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // Unchecked files (new files are included by default).
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [committing, setCommitting] = useState(false);

  useEffect(() => {
    void refreshChanges(workspaceId);
  }, [workspaceId]);

  const files = status?.isRepo ? status.files : [];
  const prefix = status?.isRepo ? status.prefix : "";
  const selected = files.filter((f) => !excluded.has(f.path));
  // Recomputed on refresh only (not on every streamed token).
  const edited = useMemo(() => {
    if (!status?.isRepo) return new Set<string>();
    const transcripts = sessions
      .peek()
      .filter((s) => s.workspaceId === workspaceId)
      .map((s) => getChatSession(s.id))
      .filter((store) => store.status.peek() === "ready")
      .map((store) => store.transcript.peek());
    return agentEditedPaths(transcripts, cwd, status.root, status.prefix);
  }, [version, workspaceId, cwd]);

  const toggle = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setExpanded(next);
  };
  const include = (path: string, on: boolean) => {
    const next = new Set(excluded);
    if (on) next.delete(path);
    else next.add(path);
    setExcluded(next);
  };

  const revert = async (file: GitChangedFile) => {
    const isNew = file.kind === "untracked" || file.kind === "added";
    const ok = await confirm({
      title: "Discard changes?",
      subject: file.path,
      message: isNew ? "will be deleted. This can't be undone." : "will go back to its last committed version. This can't be undone.",
      confirmLabel: isNew ? "Delete File" : "Discard Changes",
      destructive: true,
    });
    if (!ok) return;
    try {
      setChanges(workspaceId, await changesApi.revert(workspaceId, [file.path]));
    } catch (err) {
      notify("error", `Couldn't discard the changes: ${(err as Error).message}`);
      void refreshChanges(workspaceId);
    }
  };

  const added = files.reduce((n, f) => n + (f.added ?? 0), 0);
  const removed = files.reduce((n, f) => n + (f.removed ?? 0), 0);
  const allSelected = selected.length === files.length;

  return (
    <div
      class="flex h-full min-h-0 flex-col bg-window"
      data-changes-panel
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div
        style={{ height: `${TAB_STRIP_HEIGHT}px` }}
        class="relative flex shrink-0 items-center gap-1.5 bg-tabbar pr-1 pl-3 after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:border-b-[0.5px] after:border-separator"
      >
        <span class="font-semibold select-none">Changes</span>
        {status?.isRepo && status.branch && (
          <span class="flex min-w-0 items-center gap-1 truncate text-[0.92rem] text-fg-subtle select-none" title={`Branch ${status.branch}`}>
            <GitBranch class="size-3 shrink-0" />
            <span class="truncate">{status.branch}</span>
          </span>
        )}
        <span class="flex-1" />
        <IconButton size="sm" label="Refresh" onClick={() => void refreshChanges(workspaceId)} disabled={loading}>
          {loading ? <Spinner size={12} /> : <RefreshCw />}
        </IconButton>
        <IconButton size="sm" label="Hide Changes (Esc)" onClick={onClose}>
          <PanelRightClose />
        </IconButton>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto">
        {status === null ? (
          entry.error.value ? (
            <Empty title="Couldn't read the changes" detail={entry.error.value} />
          ) : (
            <div class="flex justify-center p-6">
              <Spinner />
            </div>
          )
        ) : !status.isRepo ? (
          <Empty title="Not a git repository" detail="This chat's folder isn't in a git repository, so there are no changes to show." />
        ) : files.length === 0 ? (
          <Empty title="No changes" detail="The working tree is clean." />
        ) : (
          <>
            <div class="flex h-7 items-center gap-2 pr-[38px] pl-3 text-[0.92rem] text-fg-muted select-none">
              <Checkbox
                checked={selected.length > 0}
                indeterminate={selected.length > 0 && !allSelected}
                onCheckedChange={() => setExcluded(allSelected ? new Set(files.map((f) => f.path)) : new Set())}
                aria-label={allSelected ? "Deselect all" : "Select all"}
              />
              <span class="flex-1">
                {files.length} changed {files.length === 1 ? "file" : "files"}
                {status.truncated && " (more not shown)"}
              </span>
              <Counts added={added} removed={removed} />
            </div>
            <ul role="list" aria-label="Changed files">
              {files.map((file) => (
                <FileRow
                  key={file.path}
                  workspaceId={workspaceId}
                  file={file}
                  prefix={prefix}
                  version={version}
                  expanded={expanded.has(file.path)}
                  included={!excluded.has(file.path)}
                  edited={edited.has(file.path)}
                  onToggle={() => toggle(file.path)}
                  onInclude={(on) => include(file.path, on)}
                  onRevert={() => void revert(file)}
                />
              ))}
            </ul>
          </>
        )}
      </div>

      {status?.isRepo && files.length > 0 && (
        <div class="flex shrink-0 items-center justify-end gap-2 border-t-[0.5px] border-separator px-3 py-2">
          <Button variant="primary" size="sm" disabled={selected.length === 0} onClick={() => setCommitting(true)}>
            {allSelected ? "Commit…" : `Commit ${selected.length} ${selected.length === 1 ? "File" : "Files"}…`}
          </Button>
        </div>
      )}

      {committing && (
        <CommitDialog
          workspaceId={workspaceId}
          paths={allSelected ? undefined : selected.map((f) => f.path)}
          count={selected.length}
          onClose={() => setCommitting(false)}
          onCommitted={() => {
            setCommitting(false);
            setExcluded(new Set());
            void refreshChanges(workspaceId);
          }}
        />
      )}
    </div>
  );
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div class="flex flex-col items-center gap-1 px-6 py-10 text-center select-none">
      <div class="font-medium text-fg-muted">{title}</div>
      <div class="text-[0.92rem] text-fg-subtle">{detail}</div>
    </div>
  );
}

function Counts({ added, removed, binary }: { added: number | null; removed: number | null; binary?: boolean }) {
  if (binary) return <span class="shrink-0 text-[0.85rem] text-fg-subtle">binary</span>;
  if (!added && !removed) return null;
  return (
    <span class="shrink-0 font-mono text-[0.85rem]">
      {added ? <span class="text-success">+{added}</span> : null}
      {added && removed ? " " : null}
      {removed ? <span class="text-danger">−{removed}</span> : null}
    </span>
  );
}

interface FileRowProps {
  workspaceId: string;
  file: GitChangedFile;
  prefix: string;
  version: number;
  expanded: boolean;
  included: boolean;
  edited: boolean;
  onToggle: () => void;
  onInclude: (on: boolean) => void;
  onRevert: () => void;
}

function FileRow({ workspaceId, file, prefix, version, expanded, included, edited, onToggle, onInclude, onRevert }: FileRowProps) {
  const kind = KIND[file.kind] ?? KIND.modified;
  const shown = prefix && file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path;
  const slash = shown.lastIndexOf("/");
  const name = shown.slice(slash + 1);
  const dir = slash >= 0 ? shown.slice(0, slash) : "";
  return (
    <li data-path={file.path}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            onToggle();
          }
        }}
        class="group flex h-7 items-center gap-2 pr-1.5 pl-3 outline-none select-none hover:bg-hover focus-visible:bg-hover"
      >
        <Checkbox checked={included} onCheckedChange={onInclude} aria-label={`Include ${file.path}`} />
        <ChevronRight class={cn("size-3 shrink-0 text-fg-subtle transition-transform duration-100", expanded && "rotate-90")} />
        <span class={cn("w-3 shrink-0 text-center font-mono text-[0.85rem] font-semibold", kind.class)} title={kind.label} aria-label={kind.label}>
          {kind.letter}
        </span>
        <span class="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span class={cn("truncate", file.kind === "deleted" && "line-through decoration-fg-subtle")}>{name}</span>
          {dir && <span class="min-w-0 truncate text-[0.88rem] text-fg-subtle">{dir}</span>}
        </span>
        {edited && <span class="size-1.5 shrink-0 rounded-full bg-accent" title="Edited by this chat's agent" aria-label="Edited by this chat's agent" />}
        <Counts added={file.added} removed={file.removed} binary={file.binary} />
        <IconButton
          size="sm"
          label="Discard Changes…"
          class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onRevert();
          }}
        >
          <Undo2 />
        </IconButton>
      </div>
      {expanded && <FileDiff workspaceId={workspaceId} path={file.path} version={version} />}
    </li>
  );
}

type DiffState = { status: "loading" } | { status: "error"; message: string } | { status: "done"; diff: GitFileDiffResponse };

function FileDiff({ workspaceId, path, version }: { workspaceId: string; path: string; version: number }) {
  const [state, setState] = useState<DiffState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    changesApi
      .diff(workspaceId, path)
      .then((diff) => !cancelled && setState({ status: "done", diff }))
      .catch((err: Error) => !cancelled && setState({ status: "error", message: err.message }));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, path, version]);

  return (
    <div class="mx-3 mt-0.5 mb-2 overflow-hidden rounded-[8px] border-[0.5px] border-separator bg-code">
      {state.status === "loading" ? (
        <div class="flex justify-center p-3">
          <Spinner size={12} />
        </div>
      ) : state.status === "error" ? (
        <div class="px-3 py-2 text-[0.92rem] text-danger">{state.message}</div>
      ) : state.diff.binary ? (
        <div class="px-3 py-2 text-[0.92rem] text-fg-subtle">Binary file</div>
      ) : state.diff.lines.length === 0 ? (
        <div class="px-3 py-2 text-[0.92rem] text-fg-subtle">No content changes</div>
      ) : (
        <>
          <DiffView lines={state.diff.lines} />
          {state.diff.truncated && <div class="px-3 py-1 text-[0.88rem] text-fg-subtle">Diff cut short (too long).</div>}
        </>
      )}
    </div>
  );
}
