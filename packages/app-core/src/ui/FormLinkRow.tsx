/**
 * A form row that opens a page (macOS System Settings' rows with a ›): label + description on the
 * left, an optional control (`accessory`, e.g. a Switch) and a chevron on the right. Clicking
 * anywhere but the accessory opens it; the label is the row's button (keyboard + accessible name),
 * the accessory sits beside it so nested controls stay valid. Use inside a `FormGroup`.
 *
 *   <FormLinkRow label="Claude Code" description="Installed" accessory={<Switch …/>} onSelect={open} />
 */
import type { ComponentChildren } from "preact";
import { ChevronRight } from "lucide-preact";
import { cn } from "@glade/app-core/lib/cn";

export interface FormLinkRowProps {
  label: ComponentChildren;
  description?: ComponentChildren;
  /** A control beside the chevron; clicks on it don't open the page. */
  accessory?: ComponentChildren;
  onSelect: () => void;
  /** The row button's accessible name (default: its text). */
  "aria-label"?: string;
  class?: string;
}

export function FormLinkRow({ label, description, accessory, onSelect, class: className, ...rest }: FormLinkRowProps) {
  return (
    <div class={cn("flex min-h-[40px] items-center gap-x-3 px-3 py-2 select-none active:bg-selected", className)} onClick={onSelect}>
      <button type="button" aria-label={rest["aria-label"]} class="min-w-0 flex-1 rounded-control text-left">
        <span class="block text-fg">{label}</span>
        {description && <span class="mt-0.5 block text-[0.92rem] leading-snug text-fg-muted">{description}</span>}
      </button>
      {accessory && (
        <div class="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {accessory}
        </div>
      )}
      <ChevronRight size={14} aria-hidden="true" class="shrink-0 text-fg-subtle" />
    </div>
  );
}
