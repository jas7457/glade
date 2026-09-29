/**
 * Text field used for renaming a row in place. Enter or blur commits, Escape cancels.
 */
import { useEffect, useRef } from "preact/hooks";
import { TextField } from "@glade/app-core/ui";

export interface InlineRenameProps {
  value: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  "aria-label"?: string;
}

export function InlineRename({ value, onCommit, onCancel, ...rest }: InlineRenameProps) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const next = ref.current?.value.trim() ?? "";
    if (commit && next && next !== value) onCommit(next);
    else onCancel();
  };
  return (
    <TextField
      ref={ref}
      size="sm"
      defaultValue={value}
      aria-label={rest["aria-label"] ?? "Name"}
      class="min-w-0 flex-1"
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.preventDefault(), finish(true));
        if (e.key === "Escape") (e.preventDefault(), finish(false));
      }}
      onBlur={() => finish(true)}
    />
  );
}
