/**
 * The capture browser (I-209): Google Chrome (Playwright, `channel: "chrome"`) at 1440×900 CSS px,
 * 2× pixels, dark mode, with the page dressed like the Mac app's window: `<html data-desktop>`
 * (the translucent, tinted sidebar the app draws over the window's vibrancy), a plain dark
 * stand-in for that vibrancy behind it, and the three traffic-light buttons at the top left where macOS puts them.
 * Nothing else of the browser shows (headless), so a screenshot is the window's content.
 */
import { chromium } from "playwright-core";

export const VIEWPORT = { width: 1440, height: 900 };

/** Runs before the app's own scripts on every page load. */
const MAC_WINDOW = () => {
  const style = document.createElement("style");
  style.textContent = `
    /* Stand-in for the window's dark vibrancy; the app paints its own sidebar tint over it (I-211). */
    html[data-desktop] { background: #232327 !important; }
    #glade-capture-traffic-lights {
      position: fixed; top: 12px; left: 14px; z-index: 2147483647; display: flex; gap: 8px; pointer-events: none;
    }
    #glade-capture-traffic-lights i {
      width: 12px; height: 12px; border-radius: 50%; display: block;
      box-shadow: inset 0 0 0 0.5px rgba(0, 0, 0, 0.25);
    }
    /* Typing caret and scrollbars don't belong in stills. */
    ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
  `;
  const lights = document.createElement("div");
  lights.id = "glade-capture-traffic-lights";
  for (const color of ["#ff5f57", "#febc2e", "#28c840"]) {
    const dot = document.createElement("i");
    dot.style.background = color;
    lights.append(dot);
  }
  const add = () => {
    document.documentElement.dataset.desktop = "";
    document.head.append(style);
    document.body.append(lights);
  };
  if (document.body) add();
  else document.addEventListener("DOMContentLoaded", add, { once: true });
};

export async function launchBrowser({ headless = true } = {}) {
  // Headless Chrome's screencast (videos) is 1× unless the browser itself is 2×; the window size
  // matches the viewport so frames aren't cropped. Screenshots still use each page's own scale.
  return chromium.launch({ channel: "chrome", headless, args: ["--hide-scrollbars", "--font-render-hinting=none", "--force-device-scale-factor=2", `--window-size=${VIEWPORT.width},${VIEWPORT.height}`] });
}

/** A new window (context + page) with the Mac look. */
export async function openWindow(browser, { viewport = VIEWPORT, scale = 2 } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: scale, colorScheme: "dark", reducedMotion: "no-preference", locale: "en-US", timezoneId: "America/Los_Angeles" });
  await context.addInitScript(MAC_WINDOW);
  const page = await context.newPage();
  return { context, page };
}

/** Waits for the app to settle: network idle-ish, fonts loaded, animations done. */
export async function settle(page, ms = 600) {
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(ms);
}

/** Moves the mouse out of the way (no hover states in stills). */
export async function parkMouse(page) {
  await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2);
}
