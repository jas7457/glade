/** keepOpenForSubmenus: a pointer landing in a (portaled) submenu doesn't dismiss its menu. */
import { describe, expect, it } from "vitest";
import { keepOpenForSubmenus } from "./Menu";

function outsideEvent(target: Element): Event {
  const e = new Event("pointerdown", { cancelable: true });
  Object.defineProperty(e, "target", { value: target });
  return e;
}

describe("keepOpenForSubmenus", () => {
  it("keeps the menu open for a pointer inside a submenu", () => {
    const sub = document.createElement("div");
    sub.setAttribute("data-radix-menu-content", "");
    const item = document.createElement("div");
    sub.append(item);
    const e = outsideEvent(item);
    keepOpenForSubmenus(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it("lets a real outside click close it", () => {
    const e = outsideEvent(document.createElement("button"));
    keepOpenForSubmenus(e);
    expect(e.defaultPrevented).toBe(false);
  });
});
