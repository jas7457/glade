/**
 * The Folder row of the iPhone's new-chat screen for a **group project** (I-213: a project with no
 * folder of its own; each chat picks its folder at creation, fixed afterwards).
 *
 * The sheet offers the folders the group's existing chats run in (derived from `workspaces`, newest
 * first; nothing new is stored) and "Browse…", the shared `FolderBrowser` in a full-height sheet
 * over that Mac's `/fs/browse` + `/fs/mkdir`, reopening where it was last left (`memoryKey`). The
 * choice goes to `setNewChatFolder` (app-core), which `createWorkspace` sends and the composer gates on.
 */
import type { WorkspaceSummary } from "@glade/protocol";
import { Folder, FolderSearch } from "lucide-preact";
import { useState } from "preact/hooks";
import { shortenPath } from "@glade/app-core/features/chat/NewChatView";
import { envFolderSource } from "@glade/app-core/state/folder-source";
import { setNewChatFolder } from "@glade/app-core/state/new-chat-folder";
import { FolderBrowser, baseName } from "@glade/app-core/ui/FolderBrowser";
import { ListGroup, Sheet } from "~/ui/phone";
import { CheckRow } from "~/ui/phone-extra";

/** The distinct folders (`cwd`) of a group's chats, the most recently created chat's folder first. */
export function groupChatFolders(projectId: string, list: readonly WorkspaceSummary[]): string[] {
  const newest = new Map<string, number>();
  for (const w of list) {
    if (w.projectId !== projectId || !w.cwd) continue;
    newest.set(w.cwd, Math.max(newest.get(w.cwd) ?? -Infinity, w.createdAt));
  }
  return [...newest.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path);
}

/** The folder picker sheet (recent chat folders + Browse…) and the browser sheet behind it. */
export function GroupFolderSheet({
  open,
  onClose,
  projectId,
  envId,
  folders,
  current,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  envId: string | null;
  /** From {@link groupChatFolders}. */
  folders: string[];
  current: string | null;
}) {
  const [browsing, setBrowsing] = useState(false);
  const choose = (path: string) => {
    setNewChatFolder(projectId, path);
    setBrowsing(false);
    onClose();
  };
  const api = envFolderSource(envId);
  return (
    <>
      <Sheet open={open && !browsing} onClose={onClose} title="Folder" full={folders.length > 8}>
        <p class="px-8 pt-1 pb-3 text-center text-[13px] text-fg-muted">Each chat in a group runs in its own folder, chosen now and kept for the chat's life.</p>
        {folders.length > 0 && (
          <ListGroup header="Used by this group's chats">
            {folders.map((path) => (
              <CheckRow key={path} icon={<Folder size={20} />} title={baseName(path)} subtitle={shortenPath(path)} checked={path === current} onClick={() => choose(path)} />
            ))}
          </ListGroup>
        )}
        <ListGroup>
          <CheckRow icon={<FolderSearch size={20} />} title={<span class="text-accent">Browse…</span>} checked={false} onClick={() => setBrowsing(true)} />
        </ListGroup>
      </Sheet>
      <Sheet open={open && browsing} onClose={() => setBrowsing(false)} title="Choose Folder" full>
        <FolderBrowser
          browse={api.browse}
          mkdir={api.mkdir}
          recent={folders}
          memoryKey={envId ?? undefined}
          openOnTap
          onChoose={choose}
          class="h-full rounded-none bg-grouped shadow-none"
        />
      </Sheet>
    </>
  );
}
