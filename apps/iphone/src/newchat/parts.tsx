/**
 * Pieces of the iPhone's new chat screen (I-166): the Glade leaf for the empty state and the small
 * chips above the composer (Mac, project) that open their pickers as sheets.
 */
import type { ComponentChildren } from "preact";
import { ChevronDown } from "lucide-preact";
import { cn } from "@glade/app-core/lib/cn";

/** The Glade leaf (the app icon's, apps/iphone/icon/icon.svg) in the accent colour. */
export function GladeLeaf({ size = 56, class: className }: { size?: number; class?: string }) {
  return (
    <svg width={size} height={size} viewBox="-340 -340 680 680" aria-hidden="true" class={cn("text-accent", className)}>
      <defs>
        <mask id="glade-leaf-veins" maskUnits="userSpaceOnUse" x="-400" y="-400" width="800" height="800">
          <rect x="-400" y="-400" width="800" height="800" fill="#fff" />
          <g fill="none" stroke="#000" stroke-linecap="round">
            <path d="M0 -205 L0 215" stroke-width="20" />
            <path d="M0 -40 Q 56 -78 90 -136" stroke-width="14" />
            <path d="M0 -40 Q -56 -78 -90 -136" stroke-width="14" />
            <path d="M0 80 Q 66 42 108 -18" stroke-width="14" />
            <path d="M0 80 Q -66 42 -108 -18" stroke-width="14" />
          </g>
        </mask>
      </defs>
      <g transform="rotate(38) translate(0 -20)">
        <path d="M0 -300 C 205 -170 215 130 0 262 C -215 130 -205 -170 0 -300 Z" fill="currentColor" mask="url(#glade-leaf-veins)" />
        <path d="M0 250 Q 4 300 -16 344" fill="none" stroke="currentColor" stroke-width="24" stroke-linecap="round" />
      </g>
    </svg>
  );
}

/** A small frosted pill above the composer: icon, value, chevron. Opens a picker. */
export function ContextChip({ icon, label, ariaLabel, onClick }: { icon: ComponentChildren; label: ComponentChildren; ariaLabel: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      class="pi-glass inline-flex h-8 max-w-[60%] min-w-0 items-center gap-1.5 rounded-full px-3 text-[14px] text-fg select-none active:opacity-70 [&>svg]:shrink-0 [&>svg]:text-fg-muted"
    >
      {icon}
      <span class="truncate">{label}</span>
      <ChevronDown size={12} strokeWidth={2.5} class="opacity-70" />
    </button>
  );
}
