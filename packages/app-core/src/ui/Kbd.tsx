/**
 * Keyboard shortcut glyphs, e.g. <Kbd keys="mod+shift+n" /> → ⌘⇧N. Pass a plain string of
 * glyphs (`"⌘N"`) or `+`-separated key names.
 */
import { cn } from "@glade/app-core/lib/cn";

const GLYPHS: Record<string, string> = {
  mod: "⌘",
  cmd: "⌘",
  meta: "⌘",
  ctrl: "⌃",
  control: "⌃",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
  enter: "↩",
  return: "↩",
  esc: "⎋",
  escape: "⎋",
  tab: "⇥",
  backspace: "⌫",
  delete: "⌫",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  space: "Space",
};

/** Convert "mod+shift+n" to "⌘⇧N". Strings without "+" are returned as-is. */
export function formatShortcut(keys: string): string {
  if (!keys.includes("+") || keys.length === 1) return GLYPHS[keys.toLowerCase()] ?? keys;
  return keys
    .split("+")
    .map((k) => GLYPHS[k.toLowerCase()] ?? k.toUpperCase())
    .join("");
}

export function Kbd({ keys, class: className }: { keys: string; class?: string }) {
  return (
    <kbd
      class={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-separator bg-control px-1 font-sans text-[0.85rem] leading-none text-fg-muted",
        className,
      )}
    >
      {formatShortcut(keys)}
    </kbd>
  );
}
