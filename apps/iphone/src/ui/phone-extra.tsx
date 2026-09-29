/**
 * More iPhone primitives (I-164): a search field, a check-mark row, a confirmation action sheet
 * and a device marker. Additions to `ui/phone.tsx` kept in their own file.
 */
import type { ComponentChildren } from "preact";
import { Check, Laptop, Search, X } from "lucide-preact";
import { cn } from "@glade/app-core/lib/cn";
import { PhoneButton, Sheet } from "./phone";

/** iOS search field (grey pill with a magnifier and a clear button). */
export function SearchField({ value, onInput, placeholder = "Search", class: className }: { value: string; onInput: (v: string) => void; placeholder?: string; class?: string }) {
  return (
    <div class={cn("relative flex h-9 items-center rounded-[10px] bg-fg/8 px-2 text-fg-muted", className)}>
      <Search size={17} class="shrink-0" aria-hidden />
      <input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onInput={(e) => onInput((e.currentTarget as HTMLInputElement).value)}
        autoCapitalize="off"
        autoCorrect="off"
        class="h-full min-w-0 flex-1 bg-transparent px-1.5 text-[17px] text-fg outline-none placeholder:text-fg-muted [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button type="button" aria-label="Clear search" onClick={() => onInput("")} class="flex size-7 items-center justify-center rounded-full active:opacity-50">
          <span class="flex size-4 items-center justify-center rounded-full bg-fg-muted text-window">
            <X size={11} strokeWidth={3} />
          </span>
        </button>
      )}
    </div>
  );
}

/** A selectable row with a trailing check mark (pickers, theme). */
export function CheckRow({ title, subtitle, checked, onClick, icon }: { title: ComponentChildren; subtitle?: ComponentChildren; checked: boolean; onClick: () => void; icon?: ComponentChildren }) {
  return (
    <button type="button" aria-pressed={checked} onClick={onClick} class="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left select-none active:bg-hover">
      {icon && <span class="flex size-7 shrink-0 items-center justify-center text-fg-muted">{icon}</span>}
      <span class="min-w-0 flex-1">
        <span class="block truncate">{title}</span>
        {subtitle && <span class="block truncate text-[13px] text-fg-muted">{subtitle}</span>}
      </span>
      <span class="flex w-6 shrink-0 justify-end text-accent">{checked && <Check size={20} aria-label="Selected" />}</span>
    </button>
  );
}

/** A confirmation as a bottom sheet: title, message, one destructive (or plain) button. */
export function ConfirmSheet({
  open,
  title,
  message,
  confirmLabel,
  destructive = true,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message?: ComponentChildren;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div class="flex flex-col gap-3 px-4 pt-1 pb-2">
        {message && <p class="text-center text-[15px] text-fg-muted">{message}</p>}
        <PhoneButton kind="tinted" class={destructive ? "bg-danger/12 text-danger active:bg-danger/20" : undefined} onClick={onConfirm}>
          {confirmLabel}
        </PhoneButton>
      </div>
    </Sheet>
  );
}

/** Small "which Mac" marker (shown when more than one Mac is connected). */
export function DeviceMarker({ name, class: className }: { name: string; class?: string }) {
  return (
    <span class={cn("inline-flex max-w-[45%] shrink-0 items-center gap-1 rounded-full bg-fg/8 px-2 py-0.5 text-[12px] font-normal text-fg-muted normal-case", className)} title={name}>
      <Laptop size={12} aria-hidden class="shrink-0" />
      <span class="truncate">{name}</span>
    </span>
  );
}
