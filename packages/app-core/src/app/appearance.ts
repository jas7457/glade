/**
 * Applies settings.appearance to <html>: `data-theme` (light/dark, following the OS live when
 * set to "system"). styles.css keys all tokens off it. (Text size was removed in I-161.)
 * In the desktop app the native window theme follows too.
 */
import { effect, signal } from "@preact/signals";
import type { Settings } from "@glade/protocol";
import { settings } from "@glade/app-core/state/store";
import { setWindowTheme } from "@glade/app-core/lib/desktop";

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
    root.dataset.theme = resolveTheme(settings.value.appearance.theme, prefersDark.value);
  });
  // Desktop app: native chrome (traffic lights, sidebar vibrancy) follows the chosen theme.
  effect(() => {
    const { theme } = settings.value.appearance;
    void setWindowTheme(theme === "system" ? null : theme).catch(() => {});
  });
}
