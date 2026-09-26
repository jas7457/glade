/**
 * Applies settings.appearance to <html>: `data-theme` (light/dark, following the OS live when
 * set to "system") and `data-font-size`. styles.css keys all tokens off these attributes.
 */
import { effect, signal } from "@preact/signals";
import type { Settings } from "@pi-ui/protocol";
import { settings } from "@/state/store";

export function resolveTheme(theme: Settings["appearance"]["theme"], prefersDark: boolean): "light" | "dark" {
  if (theme === "system") return prefersDark ? "dark" : "light";
  return theme;
}

let started = false;

export function startAppearanceSync(root: HTMLElement = document.documentElement): void {
  if (started) return;
  started = true;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const prefersDark = signal(media.matches);
  media.addEventListener?.("change", (e) => (prefersDark.value = e.matches));
  effect(() => {
    const { theme, fontSize } = settings.value.appearance;
    root.dataset.theme = resolveTheme(theme, prefersDark.value);
    root.dataset.fontSize = fontSize;
  });
}
