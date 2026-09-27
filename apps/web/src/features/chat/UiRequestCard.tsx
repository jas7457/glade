/**
 * An extension dialog (select / confirm / input / editor) shown as a prominent card above
 * the composer. The agent is paused ("blocked") until the user answers, so the card grabs
 * focus and uses the warning accent.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { MessageCircleQuestion } from "lucide-preact";
import type { UiRequest, UiResponse } from "@glade/protocol";
import { cn } from "@/lib/cn";
import { Button, TextArea, TextField } from "@/ui";

export interface UiRequestCardProps {
  request: UiRequest;
  onRespond: (response: UiResponse) => void;
  /** Number of further requests waiting behind this one. */
  more?: number;
}

export function UiRequestCard({ request, onRespond, more = 0 }: UiRequestCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(request.kind === "editor" ? request.prefill ?? "" : "");

  useEffect(() => {
    setValue(request.kind === "editor" ? request.prefill ?? "" : "");
    // Focus the first control so the user can answer from the keyboard right away.
    const first = ref.current?.querySelector<HTMLElement>("input, textarea, [data-autofocus]");
    first?.focus();
  }, [request.id]);

  const cancel = () => onRespond({ id: request.id, cancelled: true });

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={request.title}
      class="mb-2 overflow-hidden rounded-[12px] border border-warning/50 bg-surface-raised shadow-[0_4px_16px_-6px_rgb(0_0_0/0.2)]"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cancel();
        }
        // 1-9 pick an option directly.
        if (request.kind === "select" && /^[1-9]$/.test(e.key) && !(e.target instanceof HTMLInputElement)) {
          const option = request.options[Number(e.key) - 1];
          if (option !== undefined) (e.preventDefault(), onRespond({ id: request.id, value: option }));
        }
      }}
    >
      <div class="flex items-start gap-2 border-b-[0.5px] border-separator bg-warning/10 px-3 py-2">
        <MessageCircleQuestion size={15} class="mt-[2px] shrink-0 text-warning" />
        <div class="min-w-0 flex-1">
          <div class="text-[0.85rem] font-medium text-warning">The agent needs your input{more > 0 ? ` · ${more} more` : ""}</div>
          <div class="selectable font-semibold break-words whitespace-pre-wrap">{request.title}</div>
        </div>
      </div>
      <div class="px-3 py-2.5">
        {request.kind === "confirm" && (
          <>
            {request.message && <p class="selectable mb-3 break-words whitespace-pre-wrap text-fg-muted">{request.message}</p>}
            <div class="flex justify-end gap-2">
              <Button onClick={() => onRespond({ id: request.id, confirmed: false })}>Deny</Button>
              <Button variant="primary" data-autofocus onClick={() => onRespond({ id: request.id, confirmed: true })}>
                Allow
              </Button>
            </div>
          </>
        )}

        {request.kind === "select" && (
          <>
            <div class="flex max-h-64 flex-col gap-0.5 overflow-y-auto" role="listbox">
              {request.options.map((option, i) => (
                <button
                  key={option}
                  type="button"
                  role="option"
                  data-autofocus={i === 0 ? true : undefined}
                  class={cn(
                    "flex min-h-7 items-center gap-2 rounded-control px-2 py-1 text-left outline-none hover:bg-hover focus:bg-accent focus:text-accent-fg",
                  )}
                  onClick={() => onRespond({ id: request.id, value: option })}
                  onKeyDown={(e) => {
                    const buttons = [...(e.currentTarget.parentElement?.querySelectorAll("button") ?? [])];
                    const idx = buttons.indexOf(e.currentTarget);
                    if (e.key === "ArrowDown") (e.preventDefault(), buttons[idx + 1]?.focus());
                    if (e.key === "ArrowUp") (e.preventDefault(), buttons[idx - 1]?.focus());
                  }}
                >
                  <span class="w-4 shrink-0 text-right text-[0.85rem] opacity-50">{i + 1}</span>
                  <span class="min-w-0 flex-1 break-words">{option}</span>
                </button>
              ))}
            </div>
            <div class="mt-2 flex justify-end">
              <Button onClick={cancel}>Cancel</Button>
            </div>
          </>
        )}

        {request.kind === "input" && (
          <form
            class="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onRespond({ id: request.id, value });
            }}
          >
            <TextField
              value={value}
              placeholder={request.placeholder}
              onInput={(e) => setValue(e.currentTarget.value)}
              class="flex-1"
              aria-label={request.title}
            />
            <Button onClick={cancel}>Cancel</Button>
            <Button type="submit" variant="primary">
              Submit
            </Button>
          </form>
        )}

        {request.kind === "editor" && (
          <>
            <TextArea
              mono
              rows={8}
              value={value}
              onInput={(e) => setValue(e.currentTarget.value)}
              class="max-h-[40vh]"
              aria-label={request.title}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  onRespond({ id: request.id, value });
                }
              }}
            />
            <div class="mt-2 flex justify-end gap-2">
              <Button onClick={cancel}>Cancel</Button>
              <Button variant="primary" onClick={() => onRespond({ id: request.id, value })}>
                Submit
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
