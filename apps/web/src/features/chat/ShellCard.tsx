/**
 * A shell command the user ran from the composer (`!cmd` / `!!cmd`, I-076), shown like the shell
 * tool's rows (the `shell` tone, I-077): `$ command`, the output streaming in, an exit-code badge
 * when it failed, Stop while running, copy, and "Not shared with the agent" for `!!` commands.
 * Long output is cut to its last lines until expanded. History looks the same (the harness maps
 * its stored commands to `ShellMessage`s).
 */
import { memo } from "preact/compat";
import { useState } from "preact/hooks";
import { Check, Copy, EyeOff, Square, Terminal } from "lucide-preact";
import type { ShellMessage } from "@glade/protocol";
import { apiForSession } from "@/state/env-api";
import { cn } from "@/lib/cn";
import { runAction } from "@/state/chat-session";
import { IconButton, Spinner, Tooltip } from "@/ui";
import { formatDuration, useNow } from "./duration";
import { stripAnsi } from "./tools/text";

/** Output longer than this many lines is cut to its tail until expanded. */
export const SHELL_PREVIEW_LINES = 12;

/** The lines shown while collapsed: the last `max` (a running command's latest output). */
export function shellPreview(output: string, max = SHELL_PREVIEW_LINES): { text: string; hidden: number } {
  const lines = output.split("\n");
  if (lines.length <= max) return { text: output, hidden: 0 };
  return { text: lines.slice(-max).join("\n"), hidden: lines.length - max };
}

export const ShellCard = memo(function ShellCard({ message, chatId }: { message: ShellMessage; chatId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const output = stripAnsi(message.output).replace(/\n+$/, "");
  const preview = expanded ? { text: output, hidden: 0 } : shellPreview(output);
  const failed = !message.running && !message.cancelled && message.exitCode !== null && message.exitCode !== 0;
  const now = useNow(message.running, message.timestamp);
  const elapsed = message.running ? now - message.timestamp : message.endedAt !== undefined ? message.endedAt - message.timestamp : null;

  const copy = () => {
    const text = output ? `$ ${message.command}\n${output}` : `$ ${message.command}`;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      class="mt-6 overflow-hidden rounded-[10px] border-[0.5px] border-separator bg-code first:mt-0"
      data-role="shell"
      data-shared={message.shared}
      data-running={message.running || undefined}
    >
      <div class="flex min-h-8 items-center gap-2 py-1 pr-1.5 pl-2.5">
        <span class="pi-tone-icon" data-tone={failed || message.error ? "danger" : "shell"} aria-hidden="true">
          <Terminal size={12} strokeWidth={2.25} />
        </span>
        <span class="selectable min-w-0 flex-1 font-mono text-[0.92rem] leading-[1.45] break-words whitespace-pre-wrap text-fg">
          <span class="pi-tone-text select-none" data-tone="shell">
            ${" "}
          </span>
          {message.command}
        </span>
        {!message.shared && (
          <Tooltip content="Only you see this: the agent isn't told about it">
            <span class="flex shrink-0 items-center gap-1 rounded-full bg-selected px-2 py-px text-[0.8rem] text-fg-muted">
              <EyeOff size={11} />
              Not shared with the agent
            </span>
          </Tooltip>
        )}
        {failed && (
          <span class="shrink-0 rounded-full bg-danger/10 px-2 py-px font-mono text-[0.8rem] text-danger" aria-label={`Exit code ${message.exitCode}`}>
            exit {message.exitCode}
          </span>
        )}
        {message.cancelled && <span class="shrink-0 text-[0.85rem] text-fg-subtle">Stopped</span>}
        {elapsed !== null && (message.running || elapsed >= 1000) && (
          <span class="shrink-0 text-[0.85rem] text-fg-subtle tabular-nums">{formatDuration(elapsed)}</span>
        )}
        {message.running && <Spinner size={12} />}
        {message.running ? (
          <IconButton label="Stop command" size="sm" onClick={() => void runAction(() => apiForSession(chatId).abortShell(chatId), "Could not stop the command")}>
            <Square fill="currentColor" strokeWidth={0} />
          </IconButton>
        ) : (
          <IconButton label={copied ? "Copied" : "Copy command and output"} size="sm" onClick={copy}>
            {copied ? <Check /> : <Copy />}
          </IconButton>
        )}
      </div>
      {(output || message.error || (!message.running && !message.cancelled)) && (
        <div class="border-t-[0.5px] border-separator">
          {preview.hidden > 0 && (
            <button
              type="button"
              class="w-full px-3 pt-1.5 text-left text-[0.85rem] text-fg-subtle hover:text-fg"
              onClick={() => setExpanded(true)}
            >
              Show {preview.hidden} earlier {preview.hidden === 1 ? "line" : "lines"}
            </button>
          )}
          <pre
            class={cn(
              "selectable overflow-auto px-3 py-2 font-mono text-[0.88rem] leading-[1.45] break-words whitespace-pre-wrap text-fg-muted",
              expanded && "max-h-[60vh]",
            )}
          >
            {preview.text || (!message.error && !message.running && <span class="text-fg-subtle italic">(no output)</span>)}
            {message.error && <span class="block text-danger">{message.error}</span>}
          </pre>
          {expanded && (
            <button type="button" class="w-full px-3 pb-1.5 text-left text-[0.85rem] text-fg-subtle hover:text-fg" onClick={() => setExpanded(false)}>
              Show less
            </button>
          )}
          {message.truncated && (
            <div class="px-3 pb-1.5 text-[0.85rem] text-fg-subtle">
              Output truncated{message.fullOutputPath ? <> · full output in <span class="selectable font-mono">{message.fullOutputPath}</span></> : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
