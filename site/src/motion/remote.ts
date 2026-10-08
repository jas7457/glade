/**
 * The iPhone pieces. In the remote-access stage the Mac's connections lift out of its window like
 * every focus stage (focus.ts); then the two phones rise beside them at their own depths, the chat
 * list from behind the chat. In the voice section the minimized-chat phone turns in behind the
 * voice view as it scrolls in. On phones both just rise into place once.
 */
import { gsap } from "gsap";
import type { MotionContext } from "./index.ts";

export function remoteMotion(ctx: MotionContext): void {
  const section = document.querySelector<HTMLElement>("[data-remote]");
  const stage = section?.querySelector<HTMLElement>(".focus-stage");
  const chat = section?.querySelector<HTMLElement>("[data-remote-chat]");
  const list = section?.querySelector<HTMLElement>("[data-remote-list]");
  if (stage && chat && list) {
    if (ctx.desktop) {
      const tl = gsap.timeline({ scrollTrigger: { trigger: stage, start: "top 75%", end: "center 45%", scrub: 0.8 } });
      tl.fromTo(chat, { yPercent: 45, rotationX: 22, rotationY: -16, autoAlpha: 0 },
        { yPercent: 0, rotationX: 0, rotationY: -6, autoAlpha: 1, duration: 1, ease: "power3.out" }, 0.25);
      tl.fromTo(list, { xPercent: 40, yPercent: 20, rotationY: -4, autoAlpha: 0 },
        { xPercent: 0, yPercent: 0, rotationY: 8, autoAlpha: 1, duration: 0.9, ease: "power3.out" }, 0.55);
    } else {
      gsap.from([list, chat], {
        autoAlpha: 0, y: 60, duration: 0.9, ease: "power3.out", stagger: 0.12,
        scrollTrigger: { trigger: list, start: "top 92%", once: true },
      });
    }
  }

  const voice = document.querySelector<HTMLElement>("[data-voice]");
  const front = voice?.querySelector<HTMLElement>("[data-voice-front]");
  const back = voice?.querySelector<HTMLElement>("[data-voice-back]");
  if (!voice || !front || !back) return;
  if (ctx.desktop) {
    const tl = gsap.timeline({ scrollTrigger: { trigger: voice, start: "top 80%", end: "center 55%", scrub: 0.8 } });
    tl.fromTo(front, { yPercent: 18, autoAlpha: 0 }, { yPercent: 0, autoAlpha: 1, duration: 1, ease: "power3.out" }, 0);
    // Ends on its CSS pose (styles.css .phone--voice-chat).
    tl.fromTo(back, { x: 0, y: 0, xPercent: 60, yPercent: 7, z: -80, rotationY: 0, autoAlpha: 0 },
      { x: 0, y: 0, xPercent: 0, yPercent: 7, z: -80, rotationY: 14, autoAlpha: 0.8, duration: 1, ease: "power2.out" }, 0.3);
  } else {
    gsap.from([back, front], {
      autoAlpha: 0, y: 50, duration: 0.9, ease: "power3.out", stagger: 0.12,
      scrollTrigger: { trigger: voice, start: "top 85%", once: true },
    });
  }
}
