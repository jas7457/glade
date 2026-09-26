import { cn } from "@/lib/cn";

/** macOS-like activity indicator. */
export function Spinner({ class: className, size = 14 }: { class?: string; size?: number }) {
  return (
    <svg
      class={cn("animate-spin text-fg-muted", className)}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      role="status"
      aria-label="Loading"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-opacity="0.25" stroke-width="2" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>
  );
}
