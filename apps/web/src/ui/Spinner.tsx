import { cn } from "@/lib/cn";

/** macOS-like activity indicator (the classic 8-spoke "spinning gear"). */
export function Spinner({ class: className, size = 14 }: { class?: string; size?: number }) {
  return (
    <svg
      class={cn("shrink-0 text-fg-muted animate-[pi-spin_0.8s_steps(8)_infinite]", className)}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      role="status"
      aria-label="Loading"
    >
      {Array.from({ length: 8 }, (_, i) => (
        <line
          key={i}
          x1="8"
          y1="1.75"
          x2="8"
          y2="4.5"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-opacity={0.2 + (0.8 * i) / 7}
          transform={`rotate(${i * 45} 8 8)`}
        />
      ))}
    </svg>
  );
}
