/**
 * Menu-like popover with a search field on top (I-105: the new-chat project and branch pickers):
 * a small filter field over a keyboard-navigable list of rows (↑/↓, Return, Esc), optional
 * section titles, a leading checkmark column, a muted second line per row and "action" rows
 * (`persistent`) that stay visible whatever the query (e.g. "New branch…").
 *
 *   <SearchPopover trigger={<button>main</button>} placeholder="Search branches"
 *                  sections={[{ items: [{ id: "main", label: "main", checked: true }] }]}
 *                  onSelect={(id) => …} />
 *
 * Filtering is a case-insensitive substring match on `label` and `keywords`. Looks like `Menu`
 * (same surface, row height and highlight).
 */
import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import * as Popover from "@radix-ui/react-popover";
import { Check, Search } from "lucide-preact";
import { cn } from "@/lib/cn";
import { floatingSurfaceClass } from "./floating";
import { keepRowVisible } from "./list-scroll";

export interface SearchPopoverItem {
  id: string;
  label: string;
  /** Muted second line under the label. */
  detail?: ComponentChildren;
  /** Leading icon, in the checkmark column (the checkmark wins when `checked`). */
  icon?: ComponentChildren;
  /** Shows a leading checkmark. */
  checked?: boolean;
  disabled?: boolean;
  /** Extra text the search matches. */
  keywords?: string[];
  /** Always shown, not filtered (actions like "Add project…"). */
  persistent?: boolean;
}

export interface SearchPopoverSection {
  title?: string;
  items: SearchPopoverItem[];
}

export interface SearchPopoverProps {
  trigger: ComponentChildren;
  sections: SearchPopoverSection[];
  onSelect: (id: string) => void;
  placeholder?: string;
  /** Accessible name of the list. */
  label: string;
  /** Shown when nothing matches. */
  emptyText?: string;
  /** Called as the query changes (e.g. to offer "Create branch "<query>""). Reset to "" on close. */
  onQueryChange?: (query: string) => void;
  /** Rendered between the field and the list (e.g. a note why rows are disabled). */
  notice?: ComponentChildren;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  width?: number;
}

export function matchesQuery(item: SearchPopoverItem, query: string): boolean {
  if (item.persistent || !query) return true;
  const q = query.toLowerCase();
  return [item.label, ...(item.keywords ?? [])].some((text) => text.toLowerCase().includes(q));
}

export function SearchPopover({
  trigger,
  sections,
  onSelect,
  placeholder = "Search",
  label,
  emptyText = "No matches",
  onQueryChange,
  notice,
  open: openProp,
  onOpenChange,
  side = "bottom",
  align = "start",
  width = 280,
}: SearchPopoverProps) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);

  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
    if (!next) changeQuery("");
  };
  const changeQuery = (q: string) => {
    setQuery(q);
    onQueryChange?.(q);
  };

  const visible = sections.map((s) => ({ ...s, items: s.items.filter((i) => matchesQuery(i, query)) })).filter((s) => s.items.length > 0);
  const rows = visible.flatMap((s) => s.items);
  const enabled = rows.map((r, i) => (r.disabled ? -1 : i)).filter((i) => i >= 0);
  const index = enabled.includes(active) ? active : (enabled[0] ?? -1);
  const hasChecks = rows.some((r) => r.checked !== undefined);

  useEffect(() => setActive(enabled[0] ?? 0), [query, open]);
  useEffect(() => {
    if (open && index >= 0) keepRowVisible(document.getElementById(listId), document.getElementById(`${listId}-${index}`));
  }, [index, open]);

  const choose = (item: SearchPopoverItem | undefined) => {
    if (!item || item.disabled) return;
    setOpen(false);
    onSelect(item.id);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    const move = (delta: number) => {
      e.preventDefault();
      if (!enabled.length) return;
      const at = enabled.indexOf(index);
      setActive(enabled[(at + delta + enabled.length) % enabled.length]!);
    };
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Enter") {
      e.preventDefault();
      choose(rows[index]);
    }
  };

  let row = 0;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={side}
          align={align}
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            input.current?.focus();
          }}
          style={{ width: `${width}px` }}
          class={cn(
            "z-50 flex max-h-[min(420px,var(--radix-popover-content-available-height))] flex-col overflow-hidden rounded-[8px] text-[1rem] outline-none select-none",
            floatingSurfaceClass,
          )}
        >
          <div class="flex h-8 shrink-0 items-center gap-1.5 border-b border-separator px-2.5">
            <Search size={12} class="shrink-0 text-fg-subtle" aria-hidden />
            <input
              ref={input}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={index >= 0 ? `${listId}-${index}` : undefined}
              aria-autocomplete="list"
              spellcheck={false}
              autoComplete="off"
              value={query}
              placeholder={placeholder}
              onInput={(e) => changeQuery((e.currentTarget as HTMLInputElement).value)}
              onKeyDown={onKeyDown}
              class="h-full min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-subtle"
            />
          </div>
          {notice && <div class="shrink-0 border-b border-separator px-2.5 py-1.5 text-[0.88rem] leading-snug text-fg-muted">{notice}</div>}
          <div id={listId} role="listbox" aria-label={label} class="min-h-0 flex-1 overflow-y-auto p-[5px]">
            {rows.length === 0 && <div class="px-2 py-3 text-center text-fg-muted">{emptyText}</div>}
            {visible.map((section, s) => (
              <div key={section.title ?? s} role="group" aria-label={section.title}>
                {s > 0 && <div class="mx-2 my-[5px] h-px bg-separator" />}
                {section.title && <div class="px-2 pt-1 pb-0.5 text-[0.85rem] font-semibold text-fg-muted">{section.title}</div>}
                {section.items.map((item) => {
                  const i = row++;
                  const selected = i === index;
                  return (
                    <div
                      key={item.id}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={selected}
                      aria-disabled={item.disabled || undefined}
                      aria-checked={item.checked}
                      data-highlighted={selected ? "" : undefined}
                      onMouseMove={() => !item.disabled && i !== index && setActive(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(item)}
                      class={cn(
                        "flex min-h-[22px] items-center gap-2 rounded-[4px] px-2 py-[3px]",
                        hasChecks && "pl-1",
                        selected && "bg-accent text-accent-fg",
                        item.disabled && "opacity-40",
                      )}
                    >
                      {/* One leading column: the checkmark, else the row's icon (keeps labels aligned). */}
                      {item.checked ? (
                        <span class="flex w-4 shrink-0 justify-center self-start pt-[3px]">
                          <Check size={12} strokeWidth={3} />
                        </span>
                      ) : item.icon ? (
                        <span class="flex w-4 shrink-0 justify-center self-start pt-[2px] [&_svg]:size-3.5">{item.icon}</span>
                      ) : hasChecks ? (
                        <span class="w-4 shrink-0" />
                      ) : null}
                      <span class="flex min-w-0 flex-1 flex-col">
                        <span class="truncate">{item.label}</span>
                        {item.detail && <span class={cn("truncate text-[0.85rem]", selected ? "text-accent-fg/80" : "text-fg-muted")}>{item.detail}</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
