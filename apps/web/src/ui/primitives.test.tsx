import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { ConfirmHost, confirm } from "./AlertDialog";
import { SegmentedControl } from "./SegmentedControl";
import { formatShortcut } from "./Kbd";
import { Toaster } from "./Toaster";
import { TextField } from "./TextField";
import { Menu, MenuItem } from "./Menu";
import { floatingSurfaceClass } from "./floating";
import { showToast, toasts } from "@/state/toasts";

describe("confirm()", () => {
  it("resolves true on confirm and false on cancel", async () => {
    render(<ConfirmHost />);
    let result: Promise<boolean>;
    await act(async () => {
      result = confirm({ title: "Delete?", confirmLabel: "Delete", destructive: true });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(await result!).toBe(true);

    await act(async () => {
      result = confirm({ title: "Again?" });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await result!).toBe(false);
  });
});

describe("SegmentedControl", () => {
  it("selects with click and arrow keys", () => {
    function Harness() {
      const [v, setV] = useState<"a" | "b" | "c">("a");
      return <SegmentedControl value={v} onChange={setV} options={[{ value: "a", label: "A" }, { value: "b", label: "B" }, { value: "c", label: "C" }]} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("radio", { name: "B" }));
    expect(screen.getByRole("radio", { name: "B" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "C" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("Kbd", () => {
  it("formats shortcuts", () => {
    expect(formatShortcut("mod+shift+n")).toBe("⌘⇧N");
    expect(formatShortcut("⌘,")).toBe("⌘,");
  });
});

describe("Toaster", () => {
  it("renders toasts with actions", () => {
    toasts.value = [];
    const onClick = vi.fn();
    render(<Toaster />);
    act(() => void showToast({ level: "info", title: "Done", message: "Chat finished", action: { label: "View", onClick } }));
    expect(screen.getByText("Chat finished")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(onClick).toHaveBeenCalled();
    expect(toasts.value).toHaveLength(0);
  });
});

describe("TextField leadingIcon", () => {
  it("renders the icon inside the field and pads the input past it", () => {
    const { container } = render(<TextField aria-label="Name" leadingIcon={<svg data-testid="icon" />} class="extra" />);
    const icon = container.querySelector("[data-slot=leading-icon]") as HTMLElement;
    expect(icon.querySelector("[data-testid=icon]")).toBeTruthy();
    // Clicks on the icon reach the input.
    expect(icon.className).toContain("pointer-events-none");
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input.className).toContain("pl-8");
    expect(input.className).not.toMatch(/\b(px|pl)-2\b/);
    expect(input.className).toContain("extra");
  });

  it("renders a bare input without an icon", () => {
    const { container } = render(<TextField aria-label="Plain" />);
    expect(container.querySelector("[data-slot=leading-icon]")).toBeNull();
    expect(container.firstElementChild?.tagName).toBe("INPUT");
    expect(screen.getByRole("textbox").className).toContain("pl-2");
  });
});

describe("floating surfaces", () => {
  it("menus use the shared floating surface", () => {
    render(
      <Menu open trigger={<button type="button">M</button>}>
        <MenuItem>Item</MenuItem>
      </Menu>,
    );
    const menu = screen.getByRole("menu");
    for (const c of floatingSurfaceClass.split(" ")) expect(menu.className.split(" ")).toContain(c);
  });
});
