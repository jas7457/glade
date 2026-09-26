/**
 * Text field that keeps a local draft and commits on Enter or blur (Escape reverts), so
 * settings aren't saved on every keystroke.
 */
import { useEffect, useState } from "preact/hooks";
import { TextField, type TextFieldProps } from "@/ui";

export interface CommitFieldProps extends Omit<TextFieldProps, "value" | "onInput" | "onBlur" | "onKeyDown"> {
  value: string;
  onCommit: (value: string) => void;
  /** Return an error message to block the commit. */
  validate?: (value: string) => string | null;
}

export function CommitField({ value, onCommit, validate, ...props }: CommitFieldProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const error = validate?.(draft) ?? null;
  // Read the DOM value (not `draft`) so a commit right after typing never sees a stale render.
  const commit = (current: string) => {
    if (validate?.(current)) return setDraft(value);
    if (current !== value) onCommit(current);
  };
  return (
    <TextField
      {...props}
      value={draft}
      invalid={!!error}
      title={error ?? undefined}
      onInput={(e) => setDraft(e.currentTarget.value)}
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(e.currentTarget.value);
        if (e.key === "Escape") setDraft(value);
      }}
    />
  );
}
