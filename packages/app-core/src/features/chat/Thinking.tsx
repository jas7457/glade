/**
 * Reasoning block: a collapsed "Thinking…" (while streaming) / "Thought" row that expands to
 * the reasoning text. Callers skip empty/redacted thinking (see grouping.ts).
 */
import { memo } from "preact/compat";
import { useState } from "preact/hooks";
import { Brain, ChevronRight } from "lucide-preact";
import { cn } from "@glade/app-core/lib/cn";
import { Markdown } from "./Markdown";
import "./chat.css";

export const ThinkingView = memo(function ThinkingView({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="thinking">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        class="group/row -mx-1.5 flex h-7 w-[calc(100%+12px)] items-center gap-2 rounded-control px-1.5 text-left outline-none hover:bg-hover"
      >
        <Brain size={14} class="shrink-0 text-fg-subtle" />
        <span class={cn("flex-1 text-fg-muted", streaming && "pi-thinking-text")}>{streaming ? "Thinking…" : "Thought"}</span>
        <ChevronRight
          size={12}
          strokeWidth={2.5}
          class={cn("shrink-0 text-fg-subtle opacity-0 transition-transform group-hover/row:opacity-100", open && "rotate-90 opacity-100")}
        />
      </button>
      {open && (
        <div class="mt-0.5 mb-2 ml-[6px] border-l border-separator pl-[13px]">
          <Markdown text={text} streaming={streaming} class="text-[0.95rem] text-fg-muted" />
        </div>
      )}
    </div>
  );
});
