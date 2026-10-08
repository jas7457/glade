/**
 * Agents chapter: a light touch between the set pieces. The window turns to face you as it
 * scrolls in, and the three agent rows of the picker arrive one after another at their own
 * depths, as if laid on top of it.
 */
import { gsap } from "gsap";
import type { MotionContext } from "./index.ts";

export function agentsMotion(ctx: MotionContext): void {
  const stage = document.querySelector<HTMLElement>("[data-agents]");
  const win = stage?.querySelector<HTMLElement>("[data-agents-window]");
  if (!stage || !win) return;
  const rows = gsap.utils.toArray<HTMLElement>(".picker-row", stage);

  const tl = gsap.timeline({
    scrollTrigger: { trigger: stage, start: "top bottom", end: ctx.desktop ? "center 45%" : "center 60%", scrub: 0.8 },
  });
  tl.fromTo(win, { rotationY: ctx.desktop ? -14 : 0, x: ctx.desktop ? 60 : 0, y: ctx.desktop ? 0 : 40, transformPerspective: 1600 },
    { rotationY: 0, x: 0, y: 0, ease: "power2.out", duration: 1 }, 0);
  rows.forEach((row, i) => {
    const depth = Number(row.dataset.depth ?? 1);
    tl.fromTo(row, { autoAlpha: 0, y: 70 * depth, x: -20 * depth }, { autoAlpha: 1, y: 0, x: 0, ease: "power3.out", duration: 0.5 }, 0.35 + i * 0.12);
  });
}
