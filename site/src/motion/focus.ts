/**
 * Feature panels (index.html `[data-panel]`): each is one screen, the text beside its stage, both
 * sized to fit below the header (styles.css), so whatever moves is always seen whole, with its text.
 *
 * Desktop: the panel pins under the header while you scroll through it, and the motion is
 * scrubbed within that pinned stretch, so it starts and ends with everything on screen.
 * - Focus stages (markup from build/media.ts): the window starts flat and bright with its region
 *   outlined; the region lifts out of it (a copy of the window's still, clipped to the region) and
 *   flies forward until it covers the focus asset's place, the window steps back and dims, and the
 *   sharp focus asset cross-fades in over the softer copy. Extra layers (the Settings card, the
 *   phones) land last. The final pose holds for the last part of the pin.
 * - Voice: the voice view rises and the minimized chat turns in behind it.
 * Phones: no pinning; each stage fades and rises once it's entirely on screen.
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
/** Scroll distance a panel stays pinned, as a share of the viewport's height. */
const PIN_LENGTH = 0.75;

interface Box {
  l: number;
  t: number;
  w: number;
  h: number;
}
const box = (el: HTMLElement): Box => ({ l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
const navHeight = () => document.querySelector<HTMLElement>(".nav")?.offsetHeight ?? 52;

export function panelMotion(ctx: MotionContext): () => void {
  const removers: (() => void)[] = [];
  for (const panel of gsap.utils.toArray<HTMLElement>("[data-panel]")) {
    const stage = panel.querySelector<HTMLElement>("[data-focus-stage]");
    const voice = panel.querySelector<HTMLElement>("[data-voice-stage]");

    if (!ctx.desktop) {
      riseOnce(stage, voice);
      continue;
    }
    if (!stage && !voice) continue;

    const tl = gsap.timeline({
      defaults: { ease: "none" },
      scrollTrigger: {
        trigger: panel,
        pin: true,
        start: () => `top top+=${navHeight()}`,
        end: () => `+=${Math.round(window.innerHeight * PIN_LENGTH)}`,
        scrub: 0.6,
        anticipatePin: 1,
        invalidateOnRefresh: true,
      },
    });
    if (stage) removers.push(focusTimeline(stage, tl));
    else if (voice) voiceTimeline(voice, tl);
    // Hold the finished pose for the rest of the pin.
    tl.to({}, { duration: 0.3 });
  }
  return () => removers.forEach((remove) => remove());
}

/** Phones: the stage's layers fade and rise once the whole stage is on screen. */
function riseOnce(stage: HTMLElement | null, voice: HTMLElement | null): void {
  const trigger = stage ?? voice;
  if (!trigger) return;
  const targets = stage
    ? [stage.querySelector<HTMLElement>("[data-focus-front]") ?? stage, ...gsap.utils.toArray<HTMLElement>("[data-focus-extra]", stage)]
    : gsap.utils.toArray<HTMLElement>(".phone", voice!);
  gsap.from(targets, {
    autoAlpha: 0,
    y: 28,
    duration: 0.7,
    ease: "power3.out",
    stagger: 0.1,
    scrollTrigger: { trigger, start: "bottom bottom", once: true },
  });
}

function focusTimeline(stage: HTMLElement, tl: gsap.core.Timeline): () => void {
  const front = stage.querySelector<HTMLElement>("[data-focus-front]");
  const back = stage.querySelector<HTMLElement>("[data-focus-back]");
  const picture = back?.querySelector("picture");
  const extras = gsap.utils.toArray<HTMLElement>("[data-focus-extra]", stage);
  if (!front || !back || !picture) {
    tl.fromTo([front, ...extras].filter(Boolean), { autoAlpha: 0, y: 40 }, { autoAlpha: 1, y: 0, duration: 0.6, stagger: 0.1, ease: "power3.out" });
    return () => {};
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

  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
  const clipFull = () => `inset(0% 0% 0% 0% round ${(RADIUS / g.s).toFixed(1)}px)`;
  const clipRegion = `inset(${pct(ry)} ${pct(1 - rx - rw)} ${pct(1 - ry - rh)} ${pct(rx)} round ${RADIUS}px)`;

  if (ring) tl.fromTo(ring, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.1 }, 0);
  // Lift the region out of the window, then fly it forward.
  const onWindow = { x: () => g.x, y: () => g.y, scale: () => g.s, autoAlpha: 1 };
  tl.fromTo(zoom, { ...onWindow, clipPath: clipFull }, { ...onWindow, clipPath: clipRegion, duration: 0.16, ease: "power2.out" }, 0.04);
  tl.to(zoom, { x: 0, y: 0, scale: 1, duration: 0.6, ease: "power2.inOut" }, 0.2);
  // Meanwhile the window steps back and dims.
  // x/y spelled out: GSAP would otherwise read a sideways shift out of the CSS pose's matrix.
  tl.fromTo(back, { x: 0, y: 0, rotationY: 0, z: 0 }, { x: 0, y: 0, rotationY: tilt, z: DEPTH, duration: 0.6, ease: "power1.inOut" }, 0.22);
  if (dim) tl.fromTo(dim, { opacity: 0 }, { opacity: DIM, duration: 0.6 }, 0.22);
  // The sharp asset takes over from the soft copy.
  tl.fromTo(front, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.12 }, 0.78);
  tl.to(zoom, { autoAlpha: 0, duration: 0.06 }, 0.9);
  extras.forEach((extra, i) => {
    tl.fromTo(extra, { autoAlpha: 0, y: 60, z: 60 }, { autoAlpha: 1, y: 0, z: 0, duration: 0.3, ease: "power3.out" }, 0.8 + i * 0.08);
  });

  return () => {
    ScrollTrigger.removeEventListener("refreshInit", measure);
    zoom.remove();
  };
}

/** Voice: the voice view rises, then the minimized chat turns in behind it (ends on its CSS pose). */
function voiceTimeline(voice: HTMLElement, tl: gsap.core.Timeline): void {
  const front = voice.querySelector<HTMLElement>("[data-voice-front]");
  const back = voice.querySelector<HTMLElement>("[data-voice-back]");
  if (!front || !back) return;
  tl.fromTo(front, { yPercent: 14, autoAlpha: 0 }, { yPercent: 0, autoAlpha: 1, duration: 0.6, ease: "power3.out" }, 0);
  tl.fromTo(back, { x: 0, y: 0, xPercent: 60, yPercent: 7, z: -80, rotationY: 0, autoAlpha: 0 },
    { x: 0, y: 0, xPercent: 0, yPercent: 7, z: -80, rotationY: 14, autoAlpha: 0.8, duration: 0.6, ease: "power2.out" }, 0.3);
}
