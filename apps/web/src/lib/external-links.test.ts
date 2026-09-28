import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { externalHref, installExternalLinks } from "./external-links";

const ORIGIN = "http://127.0.0.1:4317";

function link(href: string, attrs: Record<string, string> = {}): HTMLAnchorElement {
  const a = document.createElement("a");
  a.setAttribute("href", href);
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  a.textContent = "link";
  document.body.appendChild(a);
  return a;
}

function click(el: Element, init: MouseEventInit = {}, type = "click"): MouseEvent {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(ev);
  return ev;
}

describe("externalHref", () => {
  it("treats other origins and mailto as external", () => {
    expect(externalHref(link("https://login.tailscale.com/admin/dns"), ORIGIN)).toBe("https://login.tailscale.com/admin/dns");
    expect(externalHref(link("http://127.0.0.1:9999/"), ORIGIN)).toBe("http://127.0.0.1:9999/");
    expect(externalHref(link("mailto:a@b.c"), ORIGIN)).toBe("mailto:a@b.c");
  });

  it("leaves app routes, anchors, downloads and other schemes alone", () => {
    expect(externalHref(link(`${ORIGIN}/chats/1`), ORIGIN)).toBeNull();
    expect(externalHref(link("#section"), ORIGIN)).toBeNull();
    expect(externalHref(link("https://example.com/f.zip", { download: "" }), ORIGIN)).toBeNull();
    expect(externalHref(link("javascript:void(0)"), ORIGIN)).toBeNull();
    expect(externalHref(link("file:///etc/hosts"), ORIGIN)).toBeNull();
  });
});

describe("installExternalLinks", () => {
  let open: ReturnType<typeof vi.fn<(url: string) => void>>;
  let desktop: boolean;
  let uninstall: () => void;

  beforeEach(() => {
    open = vi.fn<(url: string) => void>();
    desktop = true;
    uninstall = installExternalLinks({ desktop: () => desktop, open, pageOrigin: () => ORIGIN });
  });
  afterEach(() => {
    uninstall();
    document.body.innerHTML = "";
  });

  it("desktop: opens external links in the default browser and keeps the app in place", () => {
    const a = link("https://example.com/docs", { target: "_blank" });
    const ev = click(a);
    expect(ev.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("desktop: clicks on an element inside the link count", () => {
    const a = link("https://example.com/");
    const span = document.createElement("span");
    a.appendChild(span);
    click(span);
    expect(open).toHaveBeenCalledWith("https://example.com/");
  });

  it("desktop: ⌘-click, shift-click and middle click open externally too", () => {
    const a = link("https://example.com/");
    expect(click(a, { metaKey: true }).defaultPrevented).toBe(true);
    expect(click(a, { shiftKey: true }).defaultPrevented).toBe(true);
    expect(click(a, { button: 1 }, "auxclick").defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledTimes(3);
  });

  it("desktop: right clicks (auxclick button 2) are left to the context menu", () => {
    click(link("https://example.com/"), { button: 2 }, "auxclick");
    expect(open).not.toHaveBeenCalled();
  });

  it("leaves internal links and already-handled clicks alone", () => {
    const internal = link(`${ORIGIN}/settings`);
    expect(click(internal).defaultPrevented).toBe(false);
    const handled = link("https://example.com/");
    handled.addEventListener("click", (e) => e.preventDefault());
    click(handled);
    expect(open).not.toHaveBeenCalled();
  });

  it("browser: target=_blank and modifier clicks keep their default behaviour", () => {
    desktop = false;
    const a = link("https://example.com/", { target: "_blank" });
    expect(click(a).defaultPrevented).toBe(false);
    const b = link("https://example.com/");
    expect(click(b, { metaKey: true }).defaultPrevented).toBe(false);
    expect(click(b, { button: 1 }, "auxclick").defaultPrevented).toBe(false);
    expect(click(link("mailto:a@b.c")).defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("browser: an external link without a target opens a new tab instead of leaving the app", () => {
    desktop = false;
    const ev = click(link("https://example.com/"));
    expect(ev.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith("https://example.com/");
  });
});
