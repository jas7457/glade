/**
 * macOS-style search field (I-207): a text field with a magnifier inside on the left and a clear
 * button on the right while it has text. Esc clears it (and is swallowed then, so it doesn't also
 * close whatever surrounds it); on an empty field Esc passes through.
 *
 *   <SearchField aria-label="Filter models" placeholder="Filter" value={q} onValueChange={setQ} />
 */
import { forwardRef } from "preact/compat";
import { CircleX, Search } from "lucide-preact";
import { cn } from "@glade/app-core/lib/cn";
import { TextField, type TextFieldProps } from "./TextField";

export interface SearchFieldProps extends Omit<TextFieldProps, "value" | "onInput" | "leadingIcon" | "type"> {
  value: string;
  onValueChange: (value: string) => void;
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { value, onValueChange, onKeyDown, class: className, ...props },
  ref,
) {
  return (
    <div class="relative w-full min-w-0">
      <TextField
        ref={ref}
        leadingIcon={<Search />}
        value={value}
        onInput={(e) => onValueChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.key === "Escape" && value) {
            e.preventDefault();
            e.stopPropagation();
            onValueChange("");
          }
        }}
        class={cn(value && "pr-7", className as string)}
        {...props}
      />
      {value && !props.disabled && (
        <button
          type="button"
          aria-label="Clear"
          tabIndex={-1}
          onClick={() => onValueChange("")}
          class="absolute top-1/2 right-1.5 flex size-4 -translate-y-1/2 items-center justify-center text-fg-subtle hover:text-fg-muted [&_svg]:size-3.5"
        >
          <CircleX />
        </button>
      )}
    </div>
  );
});
