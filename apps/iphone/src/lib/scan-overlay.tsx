/**
 * The camera screen's chrome while scanning a pairing QR code (I-164 step 6, `lib/scan.ts`).
 *
 * The barcode scanner plugin runs **windowed**: the native camera preview sits *behind* the
 * WebView, which the plugin makes transparent. (Its full-screen mode covers the WebView with a
 * camera view that has no Cancel button, so there'd be no way out.) While scanning, this module
 * hides the app (`#app`), clears the page background so the camera shows through, and draws a
 * viewfinder, a caption and a Cancel button in its own root outside `#app`.
 *
 * The overlay is always dark (`data-theme="dark"`): it sits on a camera picture, not the app. The
 * `--color-*` tokens are resolved once at the root, so the ones used here are re-pointed at the
 * dark `--pi-*` values on the overlay's own root (`DARK_TOKENS`).
 */
import { render } from "preact";

const ROOT_ID = "glade-scan-overlay";

const DARK_TOKENS = {
  "--color-fg-strong": "var(--pi-fg-strong)",
  "--color-backdrop": "var(--pi-backdrop)",
} as Record<string, string>;

function ScanOverlay({ onCancel }: { onCancel: () => void }) {
  return (
    <div class="fixed inset-0 z-[100] flex select-none flex-col text-fg-strong" data-theme="dark" style={DARK_TOKENS} role="dialog" aria-modal="true" aria-label="Scan QR Code">
      <div class="flex shrink-0 items-center justify-between bg-backdrop px-2 pt-[env(safe-area-inset-top)]">
        <button type="button" class="h-11 px-2 text-[17px] text-fg-strong active:opacity-60" onClick={onCancel}>
          Cancel
        </button>
        <span class="text-[17px] font-semibold text-fg-strong">Scan QR Code</span>
        <span class="w-[68px]" aria-hidden="true" />
      </div>
      {/* The viewfinder: a clear square, the rest dimmed by its (huge) shadow. */}
      <div class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <div class="size-64 rounded-3xl border-2 border-fg-strong shadow-[0_0_0_100vmax_var(--color-backdrop)]" aria-hidden="true" />
      </div>
      <p class="shrink-0 bg-backdrop px-8 pt-4 pb-[max(env(safe-area-inset-bottom),24px)] text-center text-[15px] leading-snug text-fg-strong">
        On your Mac, open Glade → Settings → Remote Access → Share This Device…, then point the camera at the QR code.
      </p>
    </div>
  );
}

/** Shows the overlay; returns the function that removes it and restores the app. */
export function showScanOverlay(onCancel: () => void): () => void {
  const app = document.getElementById("app");
  const html = document.documentElement;
  const body = document.body;
  const saved = { app: app?.style.visibility ?? "", html: html.style.background, body: body.style.background };
  if (app) app.style.visibility = "hidden";
  html.style.background = "transparent";
  body.style.background = "transparent";
  document.getElementById(ROOT_ID)?.remove();
  const root = document.createElement("div");
  root.id = ROOT_ID;
  body.appendChild(root);
  render(<ScanOverlay onCancel={onCancel} />, root);
  return () => {
    render(null, root);
    root.remove();
    if (app) app.style.visibility = saved.app;
    html.style.background = saved.html;
    body.style.background = saved.body;
  };
}
