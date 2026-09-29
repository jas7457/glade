/**
 * jsdom has no layout: fake `scrollHeight` / `clientHeight` from the text (20px per line or Markdown block) and an
 * inline `max-height` in em (20px per 1.5em), enough for overflow checks like ui/Clamp's.
 */
const PX_PER_EM = 20 / 1.5;

function textHeight(el: HTMLElement): number {
  // Rendered Markdown has no newlines between blocks: count each block as a line too.
  const blocks = el.querySelectorAll("p,li,h1,h2,h3,h4,h5,h6,tr").length;
  return ((el.textContent ?? "").split("\n").length + blocks) * 20;
}

export function stubLayout(): () => void {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return textHeight(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      const max = parseFloat(this.style.maxHeight);
      return max ? Math.min(max * PX_PER_EM, textHeight(this)) : textHeight(this);
    },
  });
  return () => {
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  };
}
