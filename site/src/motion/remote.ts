/**
 * Set piece 3, the iPhone and remote access. On desktop the section pins: the Mac's window steps
 * back, the iPhone with a chat rises in front of it, and the chat list slides out from behind
 * the phone. On phones both phones simply rise into place once.
 */
import { gsap } from "gsap";
import type { MotionContext } from "./index.ts";

export function remoteMotion(ctx: MotionContext): void {
  const section = document.querySelector<HTMLElement>("[data-remote]");
  const layout = section?.querySelector<HTMLElement>(".remote-layout");
  const mac = section?.querySelector<HTMLElement>("[data-remote-mac]");
  const chat = section?.querySelector<HTMLElement>("[data-remote-chat]");
  const list = section?.querySelector<HTMLElement>("[data-remote-list]");
  if (!section || !layout || !mac || !chat || !list) return;

  if (!ctx.desktop) {
    gsap.from([list, chat], {
      autoAlpha: 0,
      y: 60,
      duration: 0.9,
      ease: "power3.out",
      stagger: 0.12,
      scrollTrigger: { trigger: chat, start: "top 92%", once: true },
    });
    return;
  }

  const tl = gsap.timeline({
    scrollTrigger: { trigger: layout, start: "center center", end: "+=1300", pin: true, scrub: 0.8, anticipatePin: 1 },
  });
  tl.fromTo(mac, { scale: 1.04, x: 0, rotationY: 0, transformPerspective: 1800 },
    { scale: 0.9, x: -30, rotationY: 10, autoAlpha: 0.6, duration: 1, ease: "power2.inOut" }, 0);
  tl.fromTo(chat, { yPercent: 70, rotationX: 28, rotationY: -18, autoAlpha: 0, transformPerspective: 1400 },
    { yPercent: 0, rotationX: 0, rotationY: -4, autoAlpha: 1, duration: 1, ease: "power3.out" }, 0.2);
  tl.fromTo(list, { xPercent: 95, rotationY: -4, autoAlpha: 0, transformPerspective: 1400 },
    { xPercent: 0, rotationY: 8, autoAlpha: 1, duration: 0.9, ease: "power3.out" }, 0.85);
  tl.to({}, { duration: 0.4 });
}
