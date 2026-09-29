import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { Dialog } from "./Dialog";
import { Select } from "./Select";

afterEach(cleanup);

/** Radix registers its outside-pointer listeners a tick after Preact runs the layer's effects. */
const settle = () => new Promise((r) => setTimeout(r, 50));

/**
 * I-139: Preact portals don't bubble events through the component tree, so Radix saw a click in
 * a menu opened from inside a Dialog (portaled to <body>) as a click outside and closed it.
 */
describe("Dialog", () => {
  function Harness({ onOpenChange }: { onOpenChange: (o: boolean) => void }) {
    const [value, setValue] = useState("a");
    return (
      <Dialog open onOpenChange={onOpenChange} title="Sheet">
        <Select
          aria-label="Pick"
          value={value}
          onChange={setValue}
          options={[
            { value: "a", label: "Alpha" },
            { value: "b", label: "Beta" },
          ]}
        />
        <span data-testid="value">{value}</span>
      </Dialog>
    );
  }

  it("stays open when an option of a Select inside it is picked with the mouse", async () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    await settle();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Pick" }), { button: 0, pointerType: "mouse" });
    const beta = await screen.findByRole("menuitemradio", { name: "Beta", hidden: true });
    await settle();
    fireEvent.pointerDown(beta, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(beta, { button: 0, pointerType: "mouse" });
    fireEvent.click(beta);
    expect(screen.getByTestId("value").textContent).toBe("b");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("still closes on a click outside", async () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    await settle();
    const overlay = document.querySelector<HTMLElement>(".bg-backdrop")!;
    fireEvent.pointerDown(overlay, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(overlay, { button: 0, pointerType: "mouse" });
    fireEvent.click(overlay);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
