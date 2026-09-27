/**
 * Context bar: where the new chat works (I-105, git projects only): Local (the project folder)
 * or a new worktree on its own branch (I-096).
 */
import { ChevronDown, FolderGit2, Laptop } from "lucide-preact";
import { newChatWorktree, resetNewChatWorktree } from "@/state/worktrees";
import { Menu, MenuCheckItem } from "@/ui";
import { barButtonClass } from "./shared";

export function WorkInPicker({ projectId }: { projectId: string }) {
  const worktree = newChatWorktree.value === projectId;
  return (
    <Menu
      side="top"
      contentClass="min-w-[250px]"
      trigger={
        <button type="button" class={barButtonClass} aria-label={`Work in: ${worktree ? "new worktree" : "local"}`}>
          {worktree ? <FolderGit2 /> : <Laptop />}
          <span class="truncate">{worktree ? "New worktree" : "Local"}</span>
          <ChevronDown size={10} strokeWidth={2.5} class="opacity-60" />
        </button>
      }
    >
      <MenuCheckItem checked={!worktree} onSelect={resetNewChatWorktree} detail="project folder">
        Local
      </MenuCheckItem>
      <MenuCheckItem checked={worktree} onSelect={() => (newChatWorktree.value = projectId)} detail="own branch & folder">
        New worktree
      </MenuCheckItem>
    </Menu>
  );
}
