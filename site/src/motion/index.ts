/**
 * Scroll motion (GSAP + ScrollTrigger). Two kinds of moments, each in its own module: the hero
 * window assembling itself (hero.ts), and every feature's focus stage, where the part that matters
 * lifts out of the whole window and comes forward (focus.ts; the phones in remote.ts). Everything is set up
 * per media condition with gsap.matchMedia, so it reverts cleanly when the window crosses the
 * breakpoint or reduced motion is switched on:
 *
 * - desktop (≥ 900px wide): the full set pieces;
 * - mobile: short time-based versions that play once;
 * - reduce: no movement, just short fades; the static layout is the HTML itself.
 */
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { focusMotion } from "./focus.ts";
import { heroMotion } from "./hero.ts";
import { remoteMotion } from "./remote.ts";

export interface MotionContext {
  desktop: boolean;
  /** A mouse or trackpad: the hero follows the pointer a little. */
  finePointer: boolean;
}

export function initMotion(): void {
  gsap.registerPlugin(ScrollTrigger);
  // Dev only: `gsap.globalTimeline.timeScale(0.2)` in the console to watch motion slowed down.
  if (import.meta.env.DEV) Object.assign(window, { gsap, ScrollTrigger });
  const mm = gsap.matchMedia();
  mm.add(
    {
      desktop: "(min-width: 900px) and (prefers-reduced-motion: no-preference)",
      mobile: "(max-width: 899px) and (prefers-reduced-motion: no-preference)",
      reduce: "(prefers-reduced-motion: reduce)",
      finePointer: "(hover: hover) and (pointer: fine)",
    },
    (context) => {
      const { desktop, mobile, reduce, finePointer } = context.conditions ?? {};
      const root = document.documentElement;
      if (reduce || !(desktop || mobile)) {
        root.classList.remove("motion");
        gentleFades();
        return;
      }
      root.classList.add("motion");
      const ctx: MotionContext = { desktop: Boolean(desktop), finePointer: Boolean(finePointer) };
      // Created top to bottom, in page order (ScrollTrigger's rule).
      const cleanups = [heroMotion(ctx), focusMotion(ctx), remoteMotion(ctx)];
      return () => cleanups.forEach((cleanup) => cleanup?.());
    },
  );
}

/** Reduced motion: no movement, only a short fade as each picture arrives. */
function gentleFades(): void {
  for (const el of gsap.utils.toArray<HTMLElement>(".focus-stage, .voice-phones")) {
    gsap.from(el, { autoAlpha: 0, duration: 0.4, ease: "power1.out", scrollTrigger: { trigger: el, start: "top 88%", once: true } });
  }
}
