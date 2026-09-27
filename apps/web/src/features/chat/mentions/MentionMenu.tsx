/**
 * The `@` file popup above the composer (I-044). Presentational like the slash menu: the
 * composer owns the query, highlighted row and keys; focus stays in the textarea.
 */
import { useLayoutEffect, useRef } from "preact/hooks";
import { File, Folder } from "lucide-preact";
import type { FileEntry } from "@pi-ui/protocol";
import { cn } from "@/lib/cn";
import { menuContentClass, menuItemClass } from "@/ui";
import { keepRowVisible } from "@/ui/list-scroll";

export const MENTION_MENU_ID = "file-mention-menu";

export function mentionOptionId(index: number): string {
  return `${MENTION_MENU_ID}-${index}`;
}

export interface MentionMenuProps {
  entries: FileEntry[];
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (entry: FileEntry) => void;
}

export function MentionMenu({ entries, activeIndex, onHover, onPick }: MentionMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    keepRowVisible(list, list?.querySelector<HTMLElement>(`#${mentionOptionId(activeIndex)}`));
  }, [activeIndex, entries]);

  return (
    <div
      ref={listRef}
      id={MENTION_MENU_ID}
      role="listbox"
      aria-label="Files"
      class={cn(menuContentClass, "absolute right-0 bottom-full left-0 mb-1.5 max-h-[min(320px,45vh)]")}
      onMouseDown={(e) => e.preventDefault()}
    >
      {entries.map((entry, i) => {
        const active = i === activeIndex;
        const slash = entry.path.lastIndexOf("/");
        const name = entry.path.slice(slash + 1);
        const dir = slash === -1 ? "" : entry.path.slice(0, slash + 1);
        const Icon = entry.kind === "dir" ? Folder : File;
        return (
          <div
            key={`${entry.kind}:${entry.path}`}
            id={mentionOptionId(i)}
            role="option"
            aria-selected={active}
            aria-label={entry.kind === "dir" ? `${entry.path}/` : entry.path}
            data-highlighted={active ? "" : undefined}
            class={cn(menuItemClass, "h-auto min-h-[22px] gap-2 py-[3px]")}
            onMouseMove={() => !active && onHover(i)}
            onClick={() => onPick(entry)}
          >
            <Icon size={13} class="shrink-0 opacity-70" />
            <span class="shrink-0 font-medium">
              {name}
              {entry.kind === "dir" && "/"}
            </span>
            {dir && <span class="min-w-0 flex-1 truncate text-right opacity-60" dir="rtl">{`\u200e${dir}`}</span>}
          </div>
        );
      })}
    </div>
  );
}
