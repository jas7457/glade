/**
 * A sub-agent report delivered to this chat (I-075): "[agent-teams] <name> finished: …",
 * "… message from <name>: …" or "… <name> exited: …" arrive as user prompts, but they aren't the
 * user's words. Shown as a compact, left-aligned card, collapsed to one line (who + a preview);
 * expanding renders the body as Markdown with a copy button, and the "still open" note as a
 * muted footnote. The text is recognized with `parseAgentMessage` (protocol), so live messages
 * and history look the same.
 *
 * In the main chat of a workspace (I-080) the agent's name is a link that opens the agent in the
 * right-hand pane (while it still exists), with an "Open" button on the row for the keyboard.
 *
 * I-084: when the agent's spawn card is in the transcript these messages are folded into it and
 * not rendered here; this card is the fallback (e.g. compacted history). Known agents show their
 * fun name and colour.
 */
import { memo } from "preact/compat";
import { useState } from "preact/hooks";
import { Bot, Check, ChevronRight, Copy, MessageSquare, OctagonAlert, PanelRight } from "lucide-preact";
import type { AgentMessage } from "@glade/protocol";
import { cn } from "@glade/app-core/lib/cn";
import { AgentIconGlyph, IconButton } from "@glade/app-core/ui";
import { useAgentLinks } from "./agent-links";
import { identityFor, useSpawnLinks } from "./spawn-context";
import { Markdown } from "./Markdown";
import "./chat.css";

const kinds = {
  finished: { icon: Bot, tone: "task", title: (from: string) => <><Name>{from}</Name> finished</> },
  message: { icon: MessageSquare, tone: "read", title: (from: string) => <>Message from <Name>{from}</Name></> },
  exited: { icon: OctagonAlert, tone: "warning", title: (from: string) => <><Name>{from}</Name> exited</> },
} as const;

function Name({ children }: { children: string }) {
  const links = useAgentLinks();
  // Its fun name in its colour when the chat knows the agent (I-084); the card sets the colour.
  const identity = identityFor(useSpawnLinks(), children);
  const label = identity ? (
    <>
      {identity.icon && <AgentIconGlyph icon={identity.icon} size={11} class="mr-1 inline align-[-1px] text-agent" />}
      <span class="font-medium text-agent">{identity.displayName}</span>
      {identity.role && <span class="text-fg-subtle"> · {identity.role}</span>}
    </>
  ) : (
    children
  );
  if (!links?.canOpen(children)) return identity ? <span>{label}</span> : <span class="font-medium text-fg-strong">{children}</span>;
  // Inside the row's toggle button, so a click opens the agent instead of expanding the card;
  // the row's "Open" button is the keyboard route.
  return (
    <span
      data-agent-link
      title={`Open ${children}`}
      class={cn("hover:underline", !identity && "font-medium text-fg-strong")}
      onClick={(e) => {
        e.stopPropagation();
        links.open(children);
      }}
    >
      {label}
    </span>
  );
}

/**
 * One line of a Markdown body for the collapsed row: the first line of prose (headings like
 * "## Summary" say little, so they're used only when there's nothing else), syntax stripped.
 */
export function agentPreview(body: string): string {
  const lines = body.split("\n").filter((l) => l.trim() && !/^\s*(```|---+\s*$|\|[-:| ]+\|\s*$)/.test(l));
  const line = lines.find((l) => !/^\s*#{1,6}\s/.test(l)) ?? lines[0] ?? "";
  return line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/^([-*+]|\d+[.)])\s+/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

export const AgentMessageCard = memo(function AgentMessageCard({ message, defaultOpen = false }: { message: AgentMessage; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const { icon: Icon, tone, title } = kinds[message.kind];
  const body = message.body.trim();
  const preview = agentPreview(body);
  const links = useAgentLinks();
  const canOpen = message.from !== "main" && !!links?.canOpen(message.from);
  const spawnLinks = useSpawnLinks();
  const identity = message.from === "main" ? null : identityFor(spawnLinks, message.from);
  const copy = () => {
    void navigator.clipboard?.writeText(body).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div
      class={cn("mt-6 overflow-hidden rounded-[10px] border-[0.5px] border-separator bg-surface first:mt-0", identity && "shadow-[inset_3px_0_0_var(--pi-agent)]")}
      data-agent-color={identity?.color}
      data-role="agent-message"
      data-kind={message.kind}
    >
      <div class="group/row flex items-center gap-1 pr-1.5 hover:bg-hover">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          class="flex h-8 min-w-0 flex-1 items-center gap-2 pl-2.5 text-left outline-none"
        >
          <span class="pi-tone-icon" data-tone={tone} aria-hidden="true">
            <Icon size={12} strokeWidth={2.25} />
          </span>
          <span class="shrink-0 text-fg-muted">{title(message.from)}</span>
          {preview && !open && <span class="min-w-0 flex-1 truncate text-fg-subtle">{preview}</span>}
          {(open || !preview) && <span class="flex-1" />}
          <ChevronRight
            size={12}
            strokeWidth={2.5}
            class={cn("shrink-0 text-fg-subtle transition-transform", open && "rotate-90")}
          />
        </button>
        {canOpen && (
          <IconButton label={`Open ${identity?.displayName ?? message.from}`} size="sm" onClick={() => links?.open(message.from)}>
            <PanelRight />
          </IconButton>
        )}
        {open && body && (
          <IconButton label={copied ? "Copied" : "Copy"} size="sm" onClick={copy}>
            {copied ? <Check /> : <Copy />}
          </IconButton>
        )}
      </div>
      {open && (
        <div class="border-t-[0.5px] border-separator px-3.5 py-2.5">
          {body ? <Markdown text={body} /> : <div class="text-fg-subtle italic">(empty)</div>}
          {message.note && <p class="selectable mt-2.5 text-[0.88rem] leading-[1.45] text-fg-subtle">{message.note}</p>}
        </div>
      )}
    </div>
  );
});
