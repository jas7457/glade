/**
 * The slash-command popup shown above the composer while typing `/name`. Presentational:
 * the composer owns the query, the highlighted item and the keyboard handling (focus never
 * leaves the textarea; items don't take focus on click).
 */
import { useLayoutEffect, useRef } from "preact/hooks";
import type { SlashCommand } from "@glade/protocol";
import { cn } from "@glade/app-core/lib/cn";
import { menuContentClass, menuItemClass } from "@glade/app-core/ui";
import { keepRowVisible } from "@glade/app-core/ui/list-scroll";
import type { CommandGroup } from "./match";

export const SLASH_MENU_ID = "slash-command-menu";

export function slashOptionId(index: number): string {
  return `${SLASH_MENU_ID}-${index}`;
}

export interface SlashMenuProps {
  groups: CommandGroup[];
  /** Index into the flattened list (group order). */
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (command: SlashCommand) => void;
}

export function SlashMenu({ groups, activeIndex, onHover, onPick }: SlashMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    // Scroll only the list (scrollIntoView would also move the transcript behind it).
    const list = listRef.current;
    keepRowVisible(list, list?.querySelector<HTMLElement>(`#${slashOptionId(activeIndex)}`));
  }, [activeIndex, groups]);

  let index = 0;
  return (
    <div
      ref={listRef}
      id={SLASH_MENU_ID}
      role="listbox"
      aria-label="Commands"
      class={cn(menuContentClass, "absolute right-0 bottom-full left-0 mb-1.5 max-h-[min(320px,45vh)]")}
      // Keep focus (and the caret) in the textarea.
      onMouseDown={(e) => e.preventDefault()}
    >
      {groups.map((group) => (
        <div key={group.source} role="group" aria-label={group.label}>
          <div class="px-2 pt-1 pb-0.5 text-[0.85rem] font-semibold text-fg-muted">{group.label}</div>
          {group.commands.map((command) => {
            const i = index++;
            const active = i === activeIndex;
            return (
              <div
                key={command.name}
                id={slashOptionId(i)}
                role="option"
                aria-selected={active}
                data-highlighted={active ? "" : undefined}
                class={cn(menuItemClass, "h-auto min-h-[22px] gap-3 py-[3px]")}
                onMouseMove={() => !active && onHover(i)}
                onClick={() => onPick(command)}
              >
                <span class="shrink-0 font-medium">
                  /{command.name}
                  {command.argsHint && <span class="ml-1 font-normal opacity-60">{command.argsHint}</span>}
                </span>
                {command.description && <span class="min-w-0 flex-1 truncate text-right opacity-60">{command.description}</span>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
