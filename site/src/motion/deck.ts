/**
 * Set piece 4, the feature deck. On desktop (and tall enough windows) the cards are sticky, so
 * each one slides up over the last; the card being covered sinks back (scales down and dims) and
 * the arriving card's pictures settle into place, the search card's bookmark window last.
 * On phones the cards stay in normal flow and only their pictures slide in.
 */
import { gsap } from "gsap";
import type { MotionContext } from "./index.ts";

/** Sticky stacking needs a card to fit the window, so only on tall enough screens. */
const STACKS = "(min-height: 700px)";

export function deckMotion(ctx: MotionContext): () => void {
  const deck = document.querySelector<HTMLElement>("[data-deck]");
  if (!deck) return () => {};
  const cards = gsap.utils.toArray<HTMLElement>(".deck-card", deck);
  const stacking = ctx.desktop && window.matchMedia(STACKS).matches;

  if (stacking) {
    deck.classList.add("is-stacking");
    cards.forEach((card, i) => card.style.setProperty("--i", String(i)));
    cards.forEach((card, i) => {
      const next = cards[i + 1];
      if (!next) return;
      const tl = gsap.timeline({
        scrollTrigger: { trigger: next, start: "top bottom", end: `top ${80 + (i + 1) * 14}px`, scrub: 0.5 },
      });
      tl.to(card.querySelector(".deck-inner"), { scale: 0.93, ease: "none" }, 0);
      tl.to(card.querySelector(".deck-shade"), { opacity: 0.55, ease: "none" }, 0);
    });
  }

  for (const card of cards) {
    const media = card.querySelector<HTMLElement>(".deck-media");
    if (!media) continue;
    const tl = gsap.timeline({ scrollTrigger: { trigger: card, start: "top bottom", end: "top 25%", scrub: 0.6 } });
    tl.fromTo(media, { y: 70, rotationX: 8, transformPerspective: 1600 }, { y: 0, rotationX: 0, ease: "power2.out" }, 0);
    const inset = card.querySelector<HTMLElement>("[data-deck-inset]");
    if (inset) tl.fromTo(inset, { x: 60, y: 40, autoAlpha: 0 }, { x: 0, y: 0, autoAlpha: 1, ease: "power2.out" }, 0.3);
  }

  return () => {
    deck.classList.remove("is-stacking");
    cards.forEach((card) => card.style.removeProperty("--i"));
  };
}
