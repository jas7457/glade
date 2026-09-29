/**
 * Appearance on the iPhone (I-164): the theme is the phone's own choice (stored on the phone, not
 * on any Mac), applied as <html data-theme> like the desktop (app/appearance.ts).
 */
import { effect, signal } from "@preact/signals";
import { resolveTheme } from "@glade/app-core/app/appearance";

export type PhoneTheme = "system" | "light" | "dark";
const KEY = "glade.iphone.theme";

function read(): PhoneTheme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export const phoneTheme = signal<PhoneTheme>(read());

export function setPhoneTheme(theme: PhoneTheme): void {
  phoneTheme.value = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* storage unavailable */
  }
}

let started = false;
export function startPhoneAppearance(root: HTMLElement = document.documentElement): void {
  if (started) return;
  started = true;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const prefersDark = signal(media.matches);
  media.addEventListener?.("change", (e) => (prefersDark.value = e.matches));
  effect(() => {
    root.dataset.theme = resolveTheme(phoneTheme.value, prefersDark.value);
  });
}
