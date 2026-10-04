/**
 * CopyableCode: a short command in a monospace box with a Copy button (setup help, I-196). The
 * text stays selectable; the button says "Copied" for a moment.
 *
 *   <CopyableCode code="llama-server --port 8080" />
 */
import { useEffect, useState } from "preact/hooks";
import { Check, Copy } from "lucide-preact";
import { cn } from "@glade/app-core/lib/cn";
import { IconButton } from "./IconButton";

export interface CopyableCodeProps {
  code: string;
  class?: string;
}

export function CopyableCode({ code, class: className }: CopyableCodeProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div class={cn("flex items-start gap-1 rounded-control bg-code py-1 pr-1 pl-2.5", className)}>
      <code class="min-w-0 flex-1 py-0.5 font-mono text-[0.92em] break-words whitespace-pre-wrap select-text">
        {/* Wrap only between words: a line break after a flag's "-" (e.g. "-ngl") reads like two arguments. */}
        {code.split(/(\s+)/).map((part, i) => (/^\s+$/.test(part) || part === "" ? part : <span key={i} class="whitespace-nowrap">{part}</span>))}
      </code>
      <IconButton label={copied ? "Copied" : "Copy"} size="sm" onClick={() => void copy()}>
        {copied ? <Check /> : <Copy />}
      </IconButton>
    </div>
  );
}
