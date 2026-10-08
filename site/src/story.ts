/**
 * The hero's story player (markup from build/story.ts). One recording plays large; for the step
 * it's in, everything outside that step's region is dimmed (the spotlight glides from region to
 * region) and a short caption sits beside it. The steps below the video follow playback (a bar
 * fills under the current one) and seek when pressed. At the end the last frame holds for a moment,
 * then it starts over.
 *
 * The video loads right away (it's the first thing on the page) and plays while most of it is on
 * screen. With reduced motion nothing autoplays: the poster shows with the steps and their captions
 * as text; pressing a step shows that moment (paused), and the play button plays it.
 */
import { gsap } from "gsap";

const PLAY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>`;
const PAUSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>`;
/** How long the last frame holds before the story starts over (ms). */
const END_HOLD = 2400;
/** Visible share of the video needed to play. */
const PLAY_RATIO = 0.6;
const GAP = 14;

interface Step {
  li: HTMLLIElement;
  button: HTMLButtonElement;
  start: number;
  end: number;
  /** x, y, w, h as fractions of the window. */
  rect: [number, number, number, number];
  caption: string;
}

const reduceQuery = () => window.matchMedia("(prefers-reduced-motion: reduce)");

export function initStory(): void {
  const root = document.querySelector<HTMLElement>("[data-story]");
  const video = root?.querySelector<HTMLVideoElement>("video[data-story-video]");
  const frame = root?.querySelector<HTMLElement>("[data-story-frame]");
  const spot = root?.querySelector<HTMLElement>("[data-story-spot]");
  const caption = root?.querySelector<HTMLElement>("[data-story-caption]");
  const toggle = root?.querySelector<HTMLButtonElement>("[data-story-toggle]");
  if (!root || !video || !frame || !spot || !caption || !toggle) return;

  const steps: Step[] = [...root.querySelectorAll<HTMLLIElement>(".story-step")].map((li) => ({
    li,
    button: li.querySelector("button")!,
    start: Number(li.dataset.start),
    end: Number(li.dataset.end),
    rect: (li.dataset.rect ?? "0 0 1 1").split(" ").map(Number) as Step["rect"],
    caption: li.querySelector(".story-step-caption")?.textContent ?? "",
  }));
  if (steps.length === 0) return;

  let reduce = reduceQuery().matches;
  let loaded = false;
  let visible = false;
  /** Paused by the visitor (or reduced motion, until they press play). */
  let userPaused = reduce;
  /** Holding the last frame before starting over. */
  let holdTimer = 0;
  let current = -1;
  let raf = 0;

  const load = () => {
    if (loaded) return;
    loaded = true;
    for (const source of video.querySelectorAll<HTMLSourceElement>("source[data-src]")) {
      source.src = source.dataset.src ?? "";
      source.removeAttribute("data-src");
    }
    video.preload = "auto";
    video.load();
  };

  const renderToggle = () => {
    const paused = userPaused || !visible;
    root.dataset.paused = String(userPaused);
    toggle.innerHTML = userPaused ? PLAY : PAUSE;
    toggle.setAttribute("aria-label", userPaused ? "Play video" : "Pause video");
    root.classList.toggle("is-playing", !paused);
  };

  const sync = () => {
    const shouldPlay = visible && !userPaused && !holdTimer;
    if (shouldPlay) {
      load();
      if (video.paused) {
        void video.play().catch(() => {
          // Autoplay refused (e.g. Low Power Mode): wait for the play button.
          userPaused = true;
          renderToggle();
        });
      }
    } else if (!video.paused) {
      video.pause();
    }
    renderToggle();
  };

  const stepAt = (t: number) => {
    let index = 0;
    steps.forEach((step, i) => {
      if (t + 0.001 >= step.start) index = i;
    });
    return index;
  };

  /** Puts the caption beside the region: right, left, below or above it, whichever fits. */
  const placeCaption = (step: Step) => {
    if (getComputedStyle(caption).position !== "absolute") {
      caption.style.left = caption.style.top = "";
      return;
    }
    const W = frame.clientWidth;
    const H = frame.clientHeight;
    const [fx, fy, fw, fh] = step.rect;
    const r = { l: fx * W, t: fy * H, w: fw * W, h: fh * H };
    const cw = caption.offsetWidth;
    const ch = caption.offsetHeight;
    const clampX = (x: number) => Math.min(Math.max(x, 8), W - cw - 8);
    const clampY = (y: number) => Math.min(Math.max(y, 8), H - ch - 8);
    const midY = clampY(r.t + r.h / 2 - ch / 2);
    let left: number;
    let top: number;
    if (W - (r.l + r.w) >= cw + GAP + 8) [left, top] = [r.l + r.w + GAP, midY];
    else if (r.l >= cw + GAP + 8) [left, top] = [r.l - GAP - cw, midY];
    else if (H - (r.t + r.h) >= ch + GAP + 8) [left, top] = [clampX(r.l + r.w / 2 - cw / 2), r.t + r.h + GAP];
    else if (r.t >= ch + GAP + 8) [left, top] = [clampX(r.l + r.w / 2 - cw / 2), r.t - GAP - ch];
    else [left, top] = [clampX(r.l + r.w - cw - 12), clampY(r.t + r.h - ch - 12)];
    caption.style.left = `${Math.round(left)}px`;
    caption.style.top = `${Math.round(top)}px`;
  };

  const showStep = (index: number, instant = reduce) => {
    if (index === current) return;
    const first = current === -1;
    current = index;
    const step = steps[index]!;
    steps.forEach((s, i) => {
      if (i === index) s.button.setAttribute("aria-current", "step");
      else s.button.removeAttribute("aria-current");
      s.li.classList.toggle("is-current", i === index);
      s.li.classList.toggle("is-done", i < index);
    });
    const [x, y, w, h] = step.rect.map((n) => `${(n * 100).toFixed(3)}%`) as [string, string, string, string];
    const move = { left: x, top: y, width: w, height: h };
    gsap.killTweensOf([spot, caption]);
    if (first || instant) {
      gsap.set(spot, move);
      gsap.to(spot, { autoAlpha: 1, duration: instant ? 0 : 0.6, ease: "power2.out" });
    } else {
      gsap.to(spot, { ...move, autoAlpha: 1, duration: 0.9, ease: "power3.inOut" });
    }
    // The caption leaves, moves while the spotlight travels, and comes back beside the new region.
    const swap = () => {
      caption.textContent = step.caption;
      placeCaption(step);
    };
    if (instant) {
      swap();
      gsap.set(caption, { autoAlpha: 1, y: 0 });
    } else {
      gsap
        .timeline()
        .to(caption, { autoAlpha: 0, duration: first ? 0 : 0.18, ease: "power1.out" })
        .add(swap)
        .fromTo(caption, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.45, ease: "power3.out" }, first ? 0.35 : 0.65);
    }
  };

  const hideSpot = () => {
    current = -1;
    gsap.to([spot, caption], { autoAlpha: 0, duration: reduce ? 0 : 0.4 });
    steps.forEach((s) => {
      s.button.removeAttribute("aria-current");
      s.li.classList.remove("is-current", "is-done");
      s.li.style.setProperty("--p", "0");
    });
  };

  const renderProgress = () => {
    const t = video.currentTime;
    const index = stepAt(t);
    steps.forEach((s, i) => {
      const p = i < index ? 1 : i > index ? 0 : Math.min(1, Math.max(0, (t - s.start) / Math.max(0.1, s.end - s.start)));
      s.li.style.setProperty("--p", p.toFixed(3));
    });
    showStep(index);
  };

  const tick = () => {
    renderProgress();
    raf = video.paused ? 0 : requestAnimationFrame(tick);
  };

  video.addEventListener("play", () => {
    root.classList.add("has-played");
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  });
  video.addEventListener("seeked", renderProgress);
  video.addEventListener("ended", () => {
    renderProgress();
    // Hold the finished answer, then start over (a quick dip so the cut doesn't jump).
    holdTimer = window.setTimeout(() => {
      gsap.to(frame, {
        autoAlpha: 0.0001,
        duration: reduce ? 0 : 0.35,
        ease: "power1.in",
        onComplete: () => {
          holdTimer = 0;
          video.currentTime = 0;
          hideSpot();
          gsap.to(frame, { autoAlpha: 1, duration: reduce ? 0 : 0.45, ease: "power2.out" });
          sync();
        },
      });
    }, END_HOLD);
  });

  const stopHold = () => {
    if (!holdTimer) return;
    clearTimeout(holdTimer);
    holdTimer = 0;
    gsap.set(frame, { autoAlpha: 1 });
  };

  steps.forEach((step, i) => {
    step.button.addEventListener("click", () => {
      stopHold();
      load();
      // Land a little into the step, so the frame shows what it's about.
      const t = userPaused ? Math.min(step.end - 0.05, step.start + (step.end - step.start) * 0.6) : step.start + 0.02;
      video.currentTime = Math.max(0, t);
      showStep(i, userPaused || reduce);
      sync();
    });
  });

  toggle.addEventListener("click", () => {
    userPaused = !userPaused;
    if (!userPaused) {
      stopHold();
      if (video.ended) video.currentTime = 0;
    }
    sync();
  });

  new IntersectionObserver(
    (entries) => {
      for (const entry of entries) visible = entry.intersectionRatio >= PLAY_RATIO;
      sync();
    },
    { threshold: [0, 0.3, PLAY_RATIO, 0.8, 1] },
  ).observe(frame);

  new ResizeObserver(() => {
    if (current >= 0) placeCaption(steps[current]!);
  }).observe(frame);

  reduceQuery().addEventListener("change", (e) => {
    reduce = e.matches;
    if (reduce) {
      userPaused = true;
      sync();
    }
  });

  gsap.set([spot, caption], { autoAlpha: 0 });
  if (!reduce) load();
  renderToggle();
}
