/**
 * Set piece 1, the hero: the app window assembles itself. Its frame fades in, then slices of the
 * capture (sidebar, tab strip, transcript, composer) fly in from different depths and land in
 * place; the real capture takes over (the video starts from its first frame, which is the poster
 * the slices were cut from) and the UI pieces around it drift in and keep floating.
 *
 * On scroll the tilted window flattens out and the floating pieces move at their own depths; with
 * a mouse the whole stage leans slightly toward the pointer.
 */
import { gsap } from "gsap";
import { releaseVideo } from "../videos.ts";
import type { MotionContext } from "./index.ts";

/** Slice regions as clip-path insets (top right bottom left, %), with where each flies in from. */
const SLICES: { inset: string; from: gsap.TweenVars }[] = [
  { inset: "0 81% 0 0", from: { x: -160, z: 140, rotationY: 26 } }, // sidebar
  { inset: "0 0 92% 19%", from: { y: -90, rotationX: -34 } }, // tab strip
  { inset: "8% 0 24% 19%", from: { z: -320, y: 50 } }, // transcript
  { inset: "76% 0 0 19%", from: { y: 140, z: 180, rotationX: 24 } }, // composer
];

/** What the slices show: the poster or image itself (never a second video), or the placeholder. */
function stillFor(slot: HTMLElement): HTMLElement | undefined {
  const video = slot.querySelector("video");
  if (video) {
    if (!video.poster) return undefined;
    const img = new Image();
    img.src = video.poster;
    img.alt = "";
    img.decoding = "async";
    return img;
  }
  const el = slot.querySelector<HTMLElement>("picture, .ph");
  if (!el) return undefined;
  const copy = el.cloneNode(true) as HTMLElement;
  copy.querySelector(".ph-tag")?.remove();
  copy.removeAttribute("role");
  copy.removeAttribute("aria-label");
  copy.querySelectorAll("img").forEach((img) => (img.alt = ""));
  return copy;
}

export function heroMotion(ctx: MotionContext): () => void {
  const stage = document.querySelector<HTMLElement>("[data-hero]");
  const mouse = document.querySelector<HTMLElement>("[data-hero-mouse]");
  const tilt = document.querySelector<HTMLElement>("[data-hero-tilt]");
  const win = document.querySelector<HTMLElement>("[data-hero-window]");
  const slot = win?.querySelector<HTMLElement>(".media");
  if (!stage || !mouse || !tilt || !win || !slot) return () => {};
  const floats = gsap.utils.toArray<HTMLElement>(".hero .float");
  const floatInners = floats.map((f) => f.querySelector<HTMLElement>(".float-mouse")!);
  const video = slot.querySelector<HTMLVideoElement>("video");
  const removers: (() => void)[] = [];

  // Resting pose: tilted back; scrolling flattens it (below).
  const restTilt = ctx.desktop ? 18 : 10;
  gsap.set(tilt, { rotationX: restTilt, scale: ctx.desktop ? 0.93 : 0.97 });

  const still = stillFor(slot);
  const tl = gsap.timeline({ delay: 0.15 });
  tl.fromTo(win, { autoAlpha: 0, y: 50, scale: 0.97 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.8, ease: "power3.out" });

  if (still) {
    video?.setAttribute("data-hold", "");
    const layer = document.createElement("div");
    layer.className = "slices";
    layer.setAttribute("aria-hidden", "true");
    const slices = SLICES.map(({ inset }) => {
      const slice = document.createElement("div");
      slice.className = "slice";
      slice.style.clipPath = `inset(${inset} round 12px)`;
      slice.append(still.cloneNode(true));
      layer.append(slice);
      return slice;
    });
    tilt.append(layer);
    removers.push(() => layer.remove());
    gsap.set(slot, { autoAlpha: 0 });
    const scale = ctx.desktop ? 1 : 0.5;
    slices.forEach((slice, i) => {
      const from = { ...SLICES[i]!.from };
      for (const k of ["x", "y", "z"] as const) if (typeof from[k] === "number") from[k] = (from[k] as number) * scale;
      tl.fromTo(
        slice,
        { ...from, autoAlpha: 0 },
        { x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, autoAlpha: 1, duration: 1.3, ease: "expo.out" },
        0.35 + i * 0.12,
      );
    });
    tl.add(() => {
      gsap.set(slot, { autoAlpha: 1 });
      if (video) releaseVideo(video);
    });
    // One frame later, so the video's first frame is up before the slices go.
    tl.set(layer, { autoAlpha: 0 }, "+=0.05");
  } else {
    tl.fromTo(slot, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.6 }, 0.3);
  }

  tl.fromTo(
    floatInners,
    { autoAlpha: 0, scale: 0.95, y: 24 },
    { autoAlpha: 1, scale: 1, y: 0, duration: 0.9, ease: "power3.out", stagger: 0.12 },
    still ? "-=0.7" : 0.6,
  );

  // Scroll: flatten the window; floating pieces drift up at their own depths.
  gsap.to(tilt, {
    rotationX: 0,
    scale: 1,
    ease: "none",
    scrollTrigger: { trigger: stage, start: 0, end: "top 12%", scrub: 0.6 },
  });
  floats.forEach((el) => {
    const depth = Number(el.dataset.depth ?? 1);
    gsap.to(el, {
      y: -110 * depth,
      ease: "none",
      scrollTrigger: { trigger: stage, start: 0, end: "bottom top", scrub: 0.6 },
    });
  });

  // Pointer: the stage leans toward it, nearer pieces move more. Starts once everything has landed.
  if (ctx.finePointer && ctx.desktop) {
    const rotY = gsap.quickTo(mouse, "rotationY", { duration: 0.9, ease: "power3.out" });
    const rotX = gsap.quickTo(mouse, "rotationX", { duration: 0.9, ease: "power3.out" });
    const movers = floats.map((el, i) => ({
      depth: Number(el.dataset.depth ?? 1),
      x: gsap.quickTo(floatInners[i]!, "x", { duration: 1.1, ease: "power3.out" }),
      y: gsap.quickTo(floatInners[i]!, "y", { duration: 1.1, ease: "power3.out" }),
    }));
    const onMove = (e: PointerEvent) => {
      const nx = e.clientX / window.innerWidth - 0.5;
      const ny = e.clientY / window.innerHeight - 0.5;
      rotY(nx * 4);
      rotX(-ny * 3);
      for (const m of movers) {
        m.x(nx * 18 * m.depth);
        m.y(ny * 14 * m.depth);
      }
    };
    tl.add(() => window.addEventListener("pointermove", onMove, { passive: true }));
    removers.push(() => window.removeEventListener("pointermove", onMove));
  }

  return () => {
    removers.forEach((remove) => remove());
    video?.removeAttribute("data-hold");
  };
}
