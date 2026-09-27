import { describe, expect, it } from "vitest";
import { groupHeaderFor, keepRowVisible, scrollRowIntoView } from "./list-scroll";

/**
 * jsdom has no layout: fake a list container of height 100 with padding 5 and rows laid out
 * from `tops` (content coordinates), 20px each.
 */
function setup() {
  const container = document.createElement("div");
  container.style.paddingTop = "5px";
  container.style.paddingBottom = "5px";
  const outer = document.createElement("div"); // a scrollable ancestor that must not move
  outer.appendChild(container);
  document.body.appendChild(outer);
  Object.defineProperty(container, "clientHeight", { value: 100 });
  const layout = new Map<HTMLElement, number>();
  const add = (parent: HTMLElement, el: HTMLElement, top: number) => {
    parent.appendChild(el);
    layout.set(el, top);
    Object.defineProperty(el, "offsetHeight", { value: 20 });
    el.getBoundingClientRect = () => ({ top: top - container.scrollTop, height: 20 }) as DOMRect;
    return el;
  };
  container.getBoundingClientRect = () => ({ top: 0, height: 100 }) as DOMRect;
  // Group A: header at 5, rows at 25, 45; group B: header 65, rows 85..265.
  const groupA = add(container, document.createElement("div"), 5);
  groupA.setAttribute("role", "group");
  const headerA = add(groupA, document.createElement("div"), 5);
  const rows: HTMLElement[] = [];
  for (const top of [25, 45]) rows.push(add(groupA, optionEl(), top));
  const groupB = add(container, document.createElement("div"), 65);
  groupB.setAttribute("role", "group");
  const headerB = add(groupB, document.createElement("div"), 65);
  for (let top = 85; top <= 265; top += 20) rows.push(add(groupB, optionEl(), top));
  return { container, outer, rows, headerA, headerB };
}

function optionEl() {
  const el = document.createElement("div");
  el.setAttribute("role", "option");
  return el;
}

describe("scrollRowIntoView", () => {
  it("does nothing when the row is visible", () => {
    const { container, rows } = setup();
    scrollRowIntoView(container, rows[1]);
    expect(container.scrollTop).toBe(0);
  });
  it("aligns a row below the viewport to the bottom edge, one row at a time", () => {
    const { container, outer, rows } = setup();
    // rows[3] spans 105..125 → bottom + padding 130 − 100.
    scrollRowIntoView(container, rows[3]);
    expect(container.scrollTop).toBe(30);
    scrollRowIntoView(container, rows[4]);
    expect(container.scrollTop).toBe(50);
    expect(outer.scrollTop).toBe(0);
  });
  it("aligns a row above the viewport to the top edge", () => {
    const { container, rows } = setup();
    container.scrollTop = 150;
    scrollRowIntoView(container, rows[5]); // top 145
    expect(container.scrollTop).toBe(140);
  });
});

describe("keepRowVisible", () => {
  it("reveals the group header when the first row of a group is selected", () => {
    const { container, rows, headerA, headerB } = setup();
    expect(groupHeaderFor(rows[0]!)).toBe(headerA);
    expect(groupHeaderFor(rows[2]!)).toBe(headerB);
    expect(groupHeaderFor(rows[3]!)).toBeNull();
    container.scrollTop = 200;
    keepRowVisible(container, rows[2]); // first of group B: header at 65
    expect(container.scrollTop).toBe(60);
    keepRowVisible(container, rows[0]); // back to the top: "Built-in" header visible
    expect(container.scrollTop).toBe(0);
  });
});
