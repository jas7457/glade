/** Swipe in from the left edge opens the chat list (I-164). */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/preact";
import { useLeftEdgeSwipe } from "./edge-swipe";

function Probe({ onSwipe }: { onSwipe: () => void }) {
  useLeftEdgeSwipe(onSwipe);
  return null;
}

const touch = (type: string, x: number, y: number) =>
  window.dispatchEvent(Object.assign(new Event(type), { touches: type === "touchend" ? [] : [{ clientX: x, clientY: y }] }));

describe("useLeftEdgeSwipe", () => {
  it("fires for a rightward swipe from the edge, not from the middle or vertically", () => {
    const onSwipe = vi.fn();
    render(<Probe onSwipe={onSwipe} />);
    touch("touchstart", 200, 400);
    touch("touchmove", 320, 400);
    touch("touchend", 0, 0);
    expect(onSwipe).not.toHaveBeenCalled();
    touch("touchstart", 5, 400);
    touch("touchmove", 20, 520);
    touch("touchmove", 80, 520);
    touch("touchend", 0, 0);
    expect(onSwipe).not.toHaveBeenCalled();
    touch("touchstart", 5, 400);
    touch("touchmove", 40, 405);
    touch("touchmove", 90, 410);
    touch("touchend", 0, 0);
    expect(onSwipe).toHaveBeenCalledTimes(1);
  });
});
