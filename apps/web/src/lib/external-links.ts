/**
 * External links (I-129): one delegated click handler for every `<a>` in the app (chat markdown,
 * tool output, settings, dialogs).
 *
 * - External = http/https to another origin than the page, or mailto.
 * - Desktop app: the Tauri webview ignores `target=_blank`, so every click on an external link
 *   (plain, ⌘/⇧/⌥-click, middle click) opens it in the default browser via the opener plugin and
 *   the app stays where it was. The shell also refuses to navigate away (src-tauri/src/links.rs).
 * - Browser: `target=_blank` links keep their default behaviour; an external link without a
 *   target opens in a new tab instead of replacing the app.
 * - Internal links (app routes), `download` links and clicks another handler already handled
 *   (`defaultPrevented`, e.g. the router's <Link>) are left alone.
 */
import { isDesktop, openExternal } from "@glade/app-core/lib/desktop";

/** The absolute URL if `anchor` points outside the app, else null. */
export function externalHref(anchor: HTMLAnchorElement, pageOrigin: string): string | null {
  if (anchor.hasAttribute("download")) return null;
  const raw = anchor.getAttribute("href");
  if (!raw || raw.startsWith("#")) return null;
  let url: URL;
  try {
    url = new URL(anchor.href || raw);
  } catch {
    return null;
  }
  if (url.protocol === "mailto:") return url.href;
  if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== pageOrigin) return url.href;
  return null;
}

export interface ExternalLinkOptions {
  root?: Document | HTMLElement;
  desktop?: () => boolean;
  open?: (url: string) => void | Promise<void>;
  pageOrigin?: () => string;
}

/** Install the handler once (main.tsx). Returns an uninstall function. */
export function installExternalLinks({
  root = document,
  desktop = isDesktop,
  open = openExternal,
  pageOrigin = () => window.location.origin,
}: ExternalLinkOptions = {}): () => void {
  const onClick = (e: Event) => {
    const ev = e as MouseEvent;
    if (ev.defaultPrevented || (ev.button !== 0 && ev.button !== 1)) return;
    // Middle clicks arrive as `auxclick`; a plain `click` with button 1 isn't fired by browsers.
    if (ev.type === "auxclick" && ev.button !== 1) return;
    const anchor = (ev.target as Element | null)?.closest?.("a[href]");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const href = externalHref(anchor, pageOrigin());
    if (!href) return;
    if (desktop()) {
      ev.preventDefault();
      void Promise.resolve(open(href)).catch((err: unknown) => console.warn("[glade] couldn't open link", err));
      return;
    }
    // Browser: modifier/middle clicks and target=_blank already open a new tab by themselves.
    const plain = ev.button === 0 && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey;
    const target = anchor.getAttribute("target");
    if (plain && !href.startsWith("mailto:") && (!target || target === "_self")) {
      ev.preventDefault();
      void open(href);
    }
  };
  root.addEventListener("click", onClick);
  root.addEventListener("auxclick", onClick);
  return () => {
    root.removeEventListener("click", onClick);
    root.removeEventListener("auxclick", onClick);
  };
}
