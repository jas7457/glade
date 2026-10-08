/**
 * Focus stages (markup from build/media.ts): every feature shows the part of the app that matters
 * (the focus asset) large in front of the whole window, which sits behind it dimmed and tilted back.
 *
 * On desktop, scrolling a stage into view tells where that part lives: the window starts flat and
 * bright with the region outlined, the region lifts out of it (a copy of the window's still,
 * clipped to the region) and flies forward until it covers the focus asset's place, the window
 * recedes, and the sharp focus asset cross-fades in over the (softer) copy. Extra layers, like the
 * Settings card in the agents stage, land last. On phones the focus asset just rises in once.
 *
 * Geometry is measured from the laid-out (untransformed) boxes and recomputed on every
 * ScrollTrigger refresh, so it follows resizes.
 */
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import type { MotionContext } from "./index.ts";

/** How far the window turns back and recedes at rest; matches `.focus-back` in styles.css. */
const TILT = 12;
const DEPTH = -90;
const DIM = 0.5;
const RADIUS = 12;

interface Box {
  l: number;
  t: number;
  w: number;
  h: number;
}
const box = (el: HTMLElement): Box => ({ l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });

export function focusMotion(ctx: MotionContext): () => void {
  const removers: (() => void)[] = [];
  for (const stage of gsap.utils.toArray<HTMLElement>("[data-focus-stage]")) {
    const front = stage.querySelector<HTMLElement>("[data-focus-front]");
    const back = stage.querySelector<HTMLElement>("[data-focus-back]");
    const picture = back?.querySelector("picture");
    const extras = gsap.utils.toArray<HTMLElement>("[data-focus-extra]", stage);
    if (!front) continue;

    if (!ctx.desktop || !back || !picture) {
      gsap.from([front, ...extras], {
        autoAlpha: 0,
        y: 40,
        duration: 0.8,
        ease: "power3.out",
        stagger: 0.12,
        scrollTrigger: { trigger: stage, start: "top 85%", once: true },
      });
      continue;
    }

    const [rx, ry, rw, rh] = (stage.dataset.focusRect ?? "0 0 1 1").split(" ").map(Number) as [number, number, number, number];
    const tilt = stage.dataset.side === "left" ? TILT : -TILT;
    const ring = back.querySelector<HTMLElement>("[data-focus-ring]");
    const dim = back.querySelector<HTMLElement>("[data-focus-dim]");

    // The copy that flies: the window's own still (same image, so no extra download).
    const zoom = document.createElement("div");
    zoom.className = "focus-zoom";
    zoom.setAttribute("aria-hidden", "true");
    zoom.append(picture.cloneNode(true));
    stage.insertBefore(zoom, front);
    removers.push(() => zoom.remove());

    // The copy is laid out where it ends (its region exactly over the focus asset) and transformed
    // back onto the window for the start.
    const g = { x: 0, y: 0, s: 1 };
    const measure = () => {
      const b = box(back);
      const f = box(front);
      const zw = f.w / rw;
      const zh = zw * (b.h / b.w);
      const zl = f.l - rx * zw;
      const zt = f.t - ry * zh;
      Object.assign(zoom.style, { left: `${zl}px`, top: `${zt}px`, width: `${zw}px`, height: `${zh}px` });
      g.x = b.l - zl;
      g.y = b.t - zt;
      g.s = b.w / zw;
    };
    measure();
    ScrollTrigger.addEventListener("refreshInit", measure);
    removers.push(() => ScrollTrigger.removeEventListener("refreshInit", measure));

    const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
    const clipFull = () => `inset(0% 0% 0% 0% round ${(RADIUS / g.s).toFixed(1)}px)`;
    const clipRegion = `inset(${pct(ry)} ${pct(1 - rx - rw)} ${pct(1 - ry - rh)} ${pct(rx)} round ${RADIUS}px)`;

    const tl = gsap.timeline({
      scrollTrigger: { trigger: stage, start: "top 82%", end: "center 52%", scrub: 0.7, invalidateOnRefresh: true },
      defaults: { ease: "none" },
    });
    if (ring) tl.fromTo(ring, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.12 }, 0);
    // Lift the region out of the window, then fly it forward.
    const onWindow = { x: () => g.x, y: () => g.y, scale: () => g.s, autoAlpha: 1 };
    tl.fromTo(zoom, { ...onWindow, clipPath: clipFull }, { ...onWindow, clipPath: clipRegion, duration: 0.18, ease: "power2.out" }, 0.08);
    tl.to(zoom, { x: 0, y: 0, scale: 1, duration: 0.6, ease: "power2.inOut" }, 0.22);
    // Meanwhile the window steps back and dims.
    // x/y spelled out: GSAP would otherwise read a sideways shift out of the CSS pose's matrix.
    tl.fromTo(back, { x: 0, y: 0, rotationY: 0, z: 0 }, { x: 0, y: 0, rotationY: tilt, z: DEPTH, duration: 0.6, ease: "power1.inOut" }, 0.25);
    if (dim) tl.fromTo(dim, { opacity: 0 }, { opacity: DIM, duration: 0.6 }, 0.25);
    // The sharp asset takes over from the soft copy.
    tl.fromTo(front, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.14 }, 0.8);
    tl.to(zoom, { autoAlpha: 0, duration: 0.06 }, 0.94);
    extras.forEach((extra, i) => {
      tl.fromTo(extra, { autoAlpha: 0, y: 70, z: 60 }, { autoAlpha: 1, y: 0, z: 0, duration: 0.3, ease: "power3.out" }, 0.82 + i * 0.06);
    });
  }
  return () => removers.forEach((remove) => remove());
}
