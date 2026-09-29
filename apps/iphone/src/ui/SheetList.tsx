/**
 * A list of options in a bottom sheet (I-164): the iPhone's form of the composer's pickers
 * (model, thinking, agent) and the Send button's options. Plugged into the shared components
 * through `OptionSheetContext` (@/features/chat/option-sheet), so the desktop keeps its menus.
 *
 *   <OptionSheetContext.Provider value={SheetList}> … </OptionSheetContext.Provider>
 */
import { Check } from "lucide-preact";
import { useEffect } from "preact/hooks";
import type { OptionSheetProps } from "@glade/app-core/features/chat/option-sheet";
import { cn } from "@glade/app-core/lib/cn";
import { Sheet } from "./phone";

export function SheetList({ open, onClose, title, sections }: OptionSheetProps) {
  // The keyboard would cover the sheet (it sits at the bottom of the layout viewport): put it away.
  useEffect(() => {
    if (open && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, [open]);
  const long = sections.reduce((n, s) => n + s.items.length, 0) > 8;
  return (
    <Sheet open={open} onClose={onClose} title={title} full={long}>
      <div class="pt-2">
        {sections.map((section, i) => (
          <section key={section.title ?? i} class="mx-4 mb-5">
            {section.title && <h2 class="px-4 pb-1.5 text-[13px] text-fg-muted uppercase">{section.title}</h2>}
            <div role="listbox" aria-label={section.title ?? title} class="overflow-hidden rounded-xl bg-surface [&>*+*]:border-t [&>*+*]:border-separator">
              {section.items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="option"
                  aria-selected={item.checked ?? undefined}
                  disabled={item.disabled}
                  onClick={item.onSelect}
                  class="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left text-[17px] select-none active:bg-hover disabled:opacity-40"
                >
                  {item.icon && <span class="flex size-7 shrink-0 items-center justify-center text-fg-muted">{item.icon}</span>}
                  <span class="min-w-0 flex-1">
                    <span class={cn("block truncate", item.checked === undefined && "text-accent")}>{item.label}</span>
                    {item.description && <span class="block text-[13px] text-fg-muted">{item.description}</span>}
                  </span>
                  {item.detail && <span class="shrink-0 text-[15px] text-fg-muted">{item.detail}</span>}
                  {item.checked !== undefined && (
                    <span class="flex w-6 shrink-0 justify-end text-accent">{item.checked && <Check size={20} strokeWidth={2.5} aria-hidden="true" />}</span>
                  )}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Sheet>
  );
}
