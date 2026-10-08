/**
 * Set piece 2, sub-agents in parallel. On desktop the section pins and scrolling drives three
 * sub-agents at once: each row's status line steps through its work while its progress line
 * fills, at its own pace and overlapping the others; each turns into a check when done, and the
 * report card lands last. On phones the same sequence plays once when it scrolls into view.
 *
 * The HTML is the finished state (every agent done, the report visible), which is also what
 * reduced motion shows.
 */
import { gsap } from "gsap";
import type { MotionContext } from "./index.ts";

/** Each agent's start and length on the timeline: overlapping, so they read as parallel. */
const PACE = [
  { at: 0, length: 3.2 },
  { at: 0.25, length: 4.4 },
  { at: 0.5, length: 3.7 },
];

export function subagentsMotion(ctx: MotionContext): void {
  const section = document.querySelector<HTMLElement>("[data-sub]");
  const layout = section?.querySelector<HTMLElement>(".sub-layout");
  const list = section?.querySelector<HTMLElement>("[data-sub-list]");
  const report = section?.querySelector<HTMLElement>("[data-sub-report]");
  const win = section?.querySelector<HTMLElement>("[data-sub-window]");
  if (!section || !layout || !list || !report || !win) return;
  const rows = gsap.utils.toArray<HTMLElement>("[data-sub-row]", list);

  const tl = gsap.timeline(
    ctx.desktop
      ? { scrollTrigger: { trigger: layout, start: "center center", end: "+=1600", pin: true, scrub: 0.8, anticipatePin: 1 } }
      : { scrollTrigger: { trigger: list, start: "top 80%", once: true }, defaults: { ease: "power2.out" } },
  );

  // Start state (set right away, not on the timeline, so it shows before the first scroll):
  // everyone just starting, no report yet.
  gsap.set(report, { autoAlpha: 0, y: 30, x: -20 });
  tl.fromTo(list, { y: ctx.desktop ? 40 : 0, autoAlpha: ctx.desktop ? 0.4 : 1 }, { y: 0, autoAlpha: 1, duration: 0.4 }, 0);
  if (ctx.desktop) tl.fromTo(win, { scale: 0.96 }, { scale: 1, duration: 5, ease: "none" }, 0);

  rows.forEach((row, i) => {
    const { at, length } = PACE[i] ?? PACE[0]!;
    const steps = gsap.utils.toArray<HTMLElement>("[data-step]", row);
    const bar = row.querySelector<HTMLElement>("[data-bar]");
    const working = row.querySelector<HTMLElement>(".status--working");
    const done = row.querySelector<SVGElement>(".status--done");
    gsap.set(steps, { autoAlpha: 0 });
    gsap.set(steps[0]!, { autoAlpha: 1 });
    if (working) gsap.set(working, { display: "inline-block", autoAlpha: 1 });
    if (done) gsap.set(done, { autoAlpha: 0, scale: 0.6, transformOrigin: "50% 50%" });
    if (bar) tl.fromTo(bar, { scaleX: 0 }, { scaleX: 1, duration: length, ease: "none" }, at);
    for (let k = 1; k < steps.length; k++) {
      const t = at + (length * k) / (steps.length - 1) - 0.25;
      tl.to(steps[k - 1]!, { autoAlpha: 0, y: -8, duration: 0.25 }, t);
      tl.fromTo(steps[k]!, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.25 }, t);
    }
    if (working) tl.to(working, { autoAlpha: 0, duration: 0.15 }, at + length);
    if (done) tl.to(done, { autoAlpha: 1, scale: 1, duration: 0.3, ease: "back.out(2)" }, at + length);
  });

  const end = Math.max(...PACE.map((p) => p.at + p.length));
  tl.to(report, { autoAlpha: 1, y: 0, x: 0, duration: 0.6, ease: "power3.out" }, end + 0.1);
  // Hold the finished state for a moment before the pin releases.
  tl.to({}, { duration: ctx.desktop ? 0.8 : 0 });
}
