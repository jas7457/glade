/**
 * Terminal colours and font from Glade's design tokens (I-187). The background, text, cursor and
 * selection come from the semantic colours (`--pi-window`, `--pi-fg`, `--pi-accent`), resolved
 * to opaque colours (xterm draws text without alpha); the 16 ANSI colours are a light and a dark
 * palette tuned for those backgrounds. The font is the system monospace at Glade's base size.
 */

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionInactiveBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

type Palette = Pick<
  TerminalTheme,
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite"
>;

const LIGHT: Palette = {
  black: "#000000",
  red: "#c91b00",
  green: "#00a600",
  yellow: "#a5a100",
  blue: "#0451a5",
  magenta: "#b300b3",
  cyan: "#0598bc",
  white: "#6e6e73",
  brightBlack: "#86868b",
  brightRed: "#e6372c",
  brightGreen: "#18b82d",
  brightYellow: "#b5ae00",
  brightBlue: "#1d6fe0",
  brightMagenta: "#c93fc9",
  brightCyan: "#11a8cd",
  brightWhite: "#1d1d1f",
};

const DARK: Palette = {
  black: "#1e1e1e",
  red: "#f14c4c",
  green: "#23d18b",
  yellow: "#e5c07b",
  blue: "#3b8eea",
  magenta: "#d670d6",
  cyan: "#29b8db",
  white: "#cccccc",
  brightBlack: "#7f7f7f",
  brightRed: "#ff6b6b",
  brightGreen: "#5af78e",
  brightYellow: "#f4f99d",
  brightBlue: "#6cb6ff",
  brightMagenta: "#ff92df",
  brightCyan: "#9aedfe",
  brightWhite: "#ffffff",
};

export const TERMINAL_FONT_FAMILY = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, monospace';

/** `#rrggbb` / `#rgb` / `rgb(a)(…)` (comma or space syntax) → [r, g, b, a], or null. */
export function parseColor(value: string): [number, number, number, number] | null {
  const v = value.trim();
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join("") : hex[1]!;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  const fn = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
  if (!fn) return null;
  const alphaRaw = fn[4];
  const alpha = alphaRaw === undefined ? 1 : alphaRaw.endsWith("%") ? parseFloat(alphaRaw) / 100 : parseFloat(alphaRaw);
  return [Number(fn[1]), Number(fn[2]), Number(fn[3]), alpha];
}

const toHex = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, "0");

/** `color` composited over the opaque `background`, as `#rrggbb`. Unparseable colours fall back to `fallback`. */
export function opaque(color: string, background: string, fallback: string): string {
  const c = parseColor(color);
  const bg = parseColor(background) ?? [255, 255, 255, 1];
  if (!c) return fallback;
  const [r, g, b, a] = c;
  return `#${toHex(r * a + bg[0] * (1 - a))}${toHex(g * a + bg[1] * (1 - a))}${toHex(b * a + bg[2] * (1 - a))}`;
}

function withAlpha(color: string, alpha: number, fallback: string): string {
  const c = parseColor(color);
  return c ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})` : fallback;
}

/** The current theme ("dark" when `<html data-theme="dark">`). */
export function isDarkTheme(root: HTMLElement = document.documentElement): boolean {
  return root.dataset.theme === "dark";
}

/**
 * Resolve a CSS colour variable to what the browser computes (e.g. `rgba(0, 0, 0, 0.84)`) with a
 * probe element, since tokens may be `color-mix()` or space-syntax `rgb()`.
 */
function resolveVar(name: string, host: HTMLElement): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  probe.style.display = "none";
  host.appendChild(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}

/** The terminal theme for the current appearance, from the tokens in effect at `host`. */
export function terminalTheme(host: HTMLElement = document.documentElement): TerminalTheme {
  const dark = isDarkTheme();
  const palette = dark ? DARK : LIGHT;
  const fallbackBg = dark ? "#1e1e1e" : "#ffffff";
  const background = opaque(resolveVar("--pi-window", host), fallbackBg, fallbackBg);
  const foreground = opaque(resolveVar("--pi-fg", host), background, dark ? "#d4d4d4" : "#2b2b2b");
  const accent = resolveVar("--pi-accent", host);
  return {
    ...palette,
    background,
    foreground,
    cursor: opaque(accent, background, foreground),
    cursorAccent: background,
    selectionBackground: withAlpha(accent, dark ? 0.4 : 0.25, "rgba(0, 122, 255, 0.3)"),
    selectionInactiveBackground: withAlpha(foreground, 0.15, "rgba(128, 128, 128, 0.2)"),
  };
}

/** Glade's base font size in px (`--pi-font-size`, 13 by default). */
export function terminalFontSize(root: HTMLElement = document.documentElement): number {
  const size = parseFloat(getComputedStyle(root).getPropertyValue("--pi-font-size"));
  return Number.isFinite(size) && size > 0 ? size : 13;
}
