import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { Lightbox, type LightboxImage } from "./Lightbox";
import { Clamp } from "./Clamp";
import { stubLayout } from "@/test/layout-stub";

const images: LightboxImage[] = [{ src: "data:image/png;base64,AAA" }, { src: "data:image/png;base64,BBB" }, { src: "data:image/png;base64,CCC" }];

function Harness({ start = 0, onChange }: { start?: number | null; onChange?: (i: number | null) => void }) {
  const [index, setIndex] = useState<number | null>(start);
  return (
    <Lightbox
      images={images}
      index={index}
      onIndexChange={(i) => {
        onChange?.(i);
        setIndex(i);
      }}
    />
  );
}

const shown = () => screen.getByTestId("lightbox").querySelector("img")!.getAttribute("src");

describe("Lightbox", () => {
  it("shows the image, steps with ← / → (wrapping) and the side buttons", () => {
    render(<Harness start={1} />);
    expect(shown()).toBe(images[1]!.src);
    expect(screen.getByText("2 / 3")).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("lightbox"), { key: "ArrowRight" });
    expect(shown()).toBe(images[2]!.src);
    fireEvent.keyDown(screen.getByTestId("lightbox"), { key: "ArrowRight" });
    expect(shown()).toBe(images[0]!.src);
    fireEvent.keyDown(screen.getByTestId("lightbox"), { key: "ArrowLeft" });
    expect(shown()).toBe(images[2]!.src);
    fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
    expect(shown()).toBe(images[1]!.src);
  });

  it("closes with Esc, ×, or a click outside the image (not on it)", () => {
    const onChange = vi.fn();
    const { unmount } = render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByTestId("lightbox").querySelector("img")!);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("lightbox"));
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByTestId("lightbox")).toBeNull();
    unmount();

    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(screen.getByTestId("lightbox"), { key: "Escape" });
    expect(screen.queryByTestId("lightbox")).toBeNull();
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("lightbox")).toBeNull();
  });

  it("single image: no arrows or counter; Copy image only where the clipboard takes images", () => {
    render(<Lightbox images={[images[0]!]} index={0} onIndexChange={() => {}} />);
    expect(screen.queryByRole("button", { name: "Next image" })).toBeNull();
    expect(screen.queryByText("1 / 1")).toBeNull();
    expect(screen.queryByText("Copy image")).toBeNull(); // jsdom: no ClipboardItem
  });

  it("offers Copy image when ClipboardItem and clipboard.write exist", () => {
    const write = vi.fn(async () => undefined);
    vi.stubGlobal("ClipboardItem", class {
      constructor(public items: Record<string, unknown>) {}
    });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
    render(<Lightbox images={[images[0]!]} index={0} onIndexChange={() => {}} />);
    fireEvent.click(screen.getByText("Copy image"));
    expect(write).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    delete (navigator as { clipboard?: unknown }).clipboard;
  });
});

describe("Clamp", () => {
  it("no toggle when the content fits; Show more / Show less when it overflows", () => {
    const restore = stubLayout();
    try {
      const { unmount } = render(<Clamp lines={3}>{"one\ntwo"}</Clamp>);
      expect(screen.queryByRole("button")).toBeNull();
      unmount();

      render(
        <Clamp lines={3} moreLabel="Show full task">
          {"1\n2\n3\n4\n5\n6"}
        </Clamp>,
      );
      const toggle = screen.getByRole("button", { name: "Show full task" });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(toggle.previousElementSibling!.getAttribute("style")).toContain("max-height");
      fireEvent.click(toggle);
      expect(screen.getByRole("button", { name: "Show less" }).previousElementSibling!.getAttribute("style") ?? "").not.toContain("max-height");
      fireEvent.click(screen.getByRole("button", { name: "Show less" }));
      expect(screen.getByRole("button", { name: "Show full task" })).toBeTruthy();
    } finally {
      restore();
    }
  });
});
