/**
 * Scroll motion (GSAP + ScrollTrigger) for the feature panels (focus.ts). The hero is a video
 * player with its own timing (src/story.ts), not scroll motion. Everything is set up per media
 * condition with gsap.matchMedia, so it reverts cleanly when the window crosses the breakpoint or
 * reduced motion is switched on:
 *
 * - desktop (≥ 900px wide): each panel scrolls normally and its motion plays once it is mostly on screen;
 * - mobile: each stage fades and rises once it's fully on screen;
 * - reduce: nothing moves; the static layout is the HTML and CSS themselves.
 */
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { panelMotion } from "./focus.ts";

export interface MotionContext {
  desktop: boolean;
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
    },
    (context) => {
      const { desktop, mobile, reduce } = context.conditions ?? {};
      const root = document.documentElement;
      if (reduce || !(desktop || mobile)) {
        root.classList.remove("motion");
        return;
      }
      root.classList.add("motion");
      return panelMotion({ desktop: Boolean(desktop) });
    },
  );
}
