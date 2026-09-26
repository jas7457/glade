/**
 * Spotlight-style command palette panel: a large search field over a grouped, keyboard-navigable
 * result list. Presentational: the caller owns the query and supplies ranked sections; this
 * primitive owns the highlighted row (↑/↓/Home/End, hover) and reports Enter/click via `onRun`.
 *
 *   <CommandPalette open={open} onOpenChange={setOpen} query={q} onQueryChange={setQ}
 *                   sections={[{ title: "Chats", items: [{ id, title, icon, shortcut }] }]}
 *                   onRun={(id) => …} />
 *
 * `badge` + `onSubmit` turn the field into a text prompt (e.g. "Rename Chat"): Enter with no
 * highlighted row calls `onSubmit(query)`.
 */
import type { ComponentChildren } from "preact";
import { useEffect, useId, useState } from "preact/hooks";
import * as RadixDialog from "@radix-ui/react-dialog";
import { Search } from "lucide-preact";
import { cn } from "@/lib/cn";
import { Kbd } from "./Kbd";
import { floatingSurfaceClass } from "./floating";

export interface CommandPaletteItem {
  id: string;
  title: string;
  /** Muted text after the title. */
  subtitle?: string;
  icon?: ComponentChildren;
  /** `formatShortcut` keys shown on the right. */
  shortcut?: string;
  /** Indices of `title` characters to emphasise (matched query letters). */
  highlights?: readonly number[];
}

export interface CommandPaletteSection {
  title: string;
  items: CommandPaletteItem[];
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  sections: CommandPaletteSection[];
  onRun: (id: string) => void;
  placeholder?: string;
  /** Label shown before the field (prompt mode). */
  badge?: string;
  /** Enter when no row is highlighted (prompt mode). */
  onSubmit?: (query: string) => void;
  /** Shown when there are no results (and no `onSubmit`). */
  emptyText?: string;
  /** Accessible name of the dialog. */
  label?: string;
}

function Highlighted({ text, indices }: { text: string; indices?: readonly number[] }) {
  if (!indices?.length) return <>{text}</>;
  const set = new Set(indices);
  const parts: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else parts.push({ text: text[i]!, hit });
  }
  return <>{parts.map((p, i) => (p.hit ? <b key={i} class="font-semibold">{p.text}</b> : <span key={i}>{p.text}</span>))}</>;
}

export function CommandPalette({
  open,
  onOpenChange,
  query,
  onQueryChange,
  sections,
  onRun,
  placeholder = "Search…",
  badge,
  onSubmit,
  emptyText = "No results",
  label = "Command Palette",
}: CommandPaletteProps) {
  const listId = useId();
  const items = sections.flatMap((s) => s.items);
  const [active, setActive] = useState(0);
  const index = items.length === 0 ? -1 : Math.min(active, items.length - 1);
  const current = index === -1 ? undefined : items[index];

  // A new query (or mode) starts from the best match.
  useEffect(() => setActive(0), [query, badge]);
  useEffect(() => {
    if (index !== -1) document.getElementById(`${listId}-${index}`)?.scrollIntoView?.({ block: "nearest" });
  }, [index, current?.id]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    const move = (to: number) => {
      e.preventDefault();
      if (items.length) setActive(((to % items.length) + items.length) % items.length);
    };
    switch (e.key) {
      case "ArrowDown":
        return move(index + 1);
      case "ArrowUp":
        return move(index - 1);
      case "Home":
        if (e.metaKey) return move(0);
        return;
      case "End":
        if (e.metaKey) return move(items.length - 1);
        return;
      case "Enter":
        e.preventDefault();
        if (current) onRun(current.id);
        else onSubmit?.(query);
        return;
    }
  };

  let row = 0;
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        {/* Spotlight doesn't dim the window; the overlay only catches outside clicks. */}
        <RadixDialog.Overlay class="fixed inset-0 z-40" />
        <RadixDialog.Content
          aria-label={label}
          style={{ width: "min(640px, calc(100vw - 32px))" }}
          class={cn(
            "fixed top-[16vh] left-1/2 z-50 flex max-h-[min(520px,70vh)] -translate-x-1/2 flex-col overflow-hidden rounded-[12px] outline-none",
            // Spotlight keeps a hint of translucency on top of the shared floating surface.
            floatingSurfaceClass,
            "bg-popover/90 backdrop-blur-2xl backdrop-saturate-150",
            "animate-[pi-pop-in_120ms_ease-out]",
          )}
        >
          <RadixDialog.Title class="sr-only">{label}</RadixDialog.Title>
          <RadixDialog.Description class="sr-only">Type to search, use the arrow keys to choose, Return to run.</RadixDialog.Description>
          <div class="flex h-12 shrink-0 items-center gap-2.5 px-4">
            <Search size={18} class="shrink-0 text-fg-muted" aria-hidden />
            {badge && <span class="shrink-0 rounded-[5px] bg-selected px-1.5 py-0.5 text-[0.85rem] font-medium text-fg-muted">{badge}</span>}
            <input
              autoFocus
              role="combobox"
              aria-expanded={items.length > 0}
              aria-controls={listId}
              aria-activedescendant={current ? `${listId}-${index}` : undefined}
              aria-autocomplete="list"
              spellcheck={false}
              autoComplete="off"
              value={query}
              placeholder={placeholder}
              onInput={(e) => onQueryChange((e.currentTarget as HTMLInputElement).value)}
              onKeyDown={onKeyDown}
              class="h-full min-w-0 flex-1 bg-transparent text-[1.3rem] font-light text-fg outline-none placeholder:text-fg-subtle"
            />
          </div>
          {(items.length > 0 || !onSubmit) && (
            <div id={listId} role="listbox" aria-label="Results" class="min-h-0 flex-1 overflow-y-auto border-t border-separator p-1.5">
              {items.length === 0 && <div class="px-3 py-6 text-center text-fg-muted">{emptyText}</div>}
              {sections.map((section) =>
                section.items.length === 0 ? null : (
                  <div key={section.title} role="group" aria-label={section.title}>
                    <div class="px-2.5 pt-2 pb-1 text-[0.8rem] font-semibold text-fg-subtle">{section.title}</div>
                    {section.items.map((item) => {
                      const i = row++;
                      const selected = i === index;
                      return (
                        <div
                          key={item.id}
                          id={`${listId}-${i}`}
                          data-id={item.id}
                          role="option"
                          aria-selected={selected}
                          onMouseMove={() => i !== index && setActive(i)}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => onRun(item.id)}
                          class={cn(
                            "flex h-8 items-center gap-2.5 rounded-[6px] px-2.5",
                            selected ? "bg-accent text-accent-fg" : "text-fg",
                          )}
                        >
                          <span class={cn("flex w-4 shrink-0 items-center justify-center [&_svg]:size-4", selected ? "text-accent-fg" : "text-fg-muted")}>
                            {item.icon}
                          </span>
                          <span class="min-w-0 flex-1 truncate">
                            <Highlighted text={item.title} indices={item.highlights} />
                            {item.subtitle && <span class={cn("ml-2", selected ? "text-accent-fg/75" : "text-fg-subtle")}>{item.subtitle}</span>}
                          </span>
                          {item.shortcut && (
                            <Kbd keys={item.shortcut} class={cn("shrink-0", selected && "border-accent-fg/30 bg-accent-fg/15 text-accent-fg")} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                ),
              )}
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
