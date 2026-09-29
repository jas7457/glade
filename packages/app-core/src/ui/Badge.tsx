/**
 * Badge: a small, subtle outlined label with an optional icon, for metadata next to a title
 * (e.g. a chat's worktree branch in the header, I-096). Not interactive; the tooltip is `title`.
 *
 *   <Badge icon={<GitBranch />} title="Branch glade/foo">glade/foo</Badge>
 *   <Badge lead="Worktree" icon={<GitBranch />}>glade/foo</Badge>   // "Worktree · ⑂ glade/foo" (I-107)
 */
import type { ComponentChildren } from "preact";
import { cn } from "@glade/app-core/lib/cn";

export interface BadgeProps {
  /** A short word before the icon, separated by a dot (e.g. "Local"). */
  lead?: ComponentChildren;
  icon?: ComponentChildren;
  title?: string;
  children: ComponentChildren;
  class?: string;
}

export function Badge({ lead, icon, title, children, class: className }: BadgeProps) {
  return (
    <span
      title={title}
      class={cn(
        "inline-flex min-w-0 items-center gap-1 rounded-[5px] border-[0.5px] border-separator px-1.5 text-[0.85rem] leading-[18px] text-fg-muted select-none [&_svg]:size-3 [&_svg]:shrink-0",
        className,
      )}
    >
      {lead != null && (
        <>
          <span class="shrink-0">{lead}</span>
          <span aria-hidden="true" class="shrink-0 text-fg-subtle">
            ·
          </span>
        </>
      )}
      {icon}
      <span class="min-w-0 truncate">{children}</span>
    </span>
  );
}
