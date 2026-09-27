import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import { SplitView } from "./SplitView";
import { TabStrip } from "./TabStrip";

const tabs = [
  { id: "a", title: "Alpha", status: "idle" as const },
  { id: "b", title: "Beta", status: "unread" as const },
  { id: "c", title: "Gamma", status: "working" as const, closable: false },
];

describe("TabStrip", () => {
  it("selects with click and arrow keys (wrapping), closes with the button or middle click", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<TabStrip label="Tabs" tabs={tabs} activeId="a" onSelect={onSelect} onClose={onClose} />);
    const [a, b, c] = screen.getAllByRole("tab");
    expect(a!.getAttribute("aria-selected")).toBe("true");
    expect(a!.tabIndex).toBe(0);
    expect(b!.tabIndex).toBe(-1);
    fireEvent.click(b!);
    expect(onSelect).toHaveBeenLastCalledWith("b");
    fireEvent.keyDown(a!, { key: "ArrowLeft" });
    expect(onSelect).toHaveBeenLastCalledWith("c");
    fireEvent.click(screen.getByRole("button", { name: "Close Beta" }));
    expect(onClose).toHaveBeenLastCalledWith("b");
    expect(onSelect).toHaveBeenCalledTimes(2);
    fireEvent(b!, new MouseEvent("auxclick", { button: 1, bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Close Gamma" })).toBeNull();
    fireEvent(c!, new MouseEvent("auxclick", { button: 1, bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("renames inline: Enter reports the new title, Escape cancels", () => {
    const onRenameDone = vi.fn();
    const { rerender } = render(<TabStrip label="Tabs" tabs={tabs} activeId="a" onSelect={() => {}} renamingId="a" onRenameDone={onRenameDone} />);
    const input = screen.getByRole("textbox", { name: "Tab title" }) as HTMLInputElement;
    input.value = "Renamed";
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRenameDone).toHaveBeenLastCalledWith("a", "Renamed");
    rerender(<TabStrip label="Tabs" tabs={tabs} activeId="a" onSelect={() => {}} renamingId="b" onRenameDone={onRenameDone} />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Tab title" }), { key: "Escape" });
    expect(onRenameDone).toHaveBeenLastCalledWith("b", null);
  });
});

describe("SplitView", () => {
  it("shows the divider only with an end pane and resizes with the arrow keys", () => {
    const onResizeEnd = vi.fn();
    const { rerender } = render(<SplitView start={<div>main</div>} size={0.5} />);
    expect(screen.queryByRole("separator")).toBeNull();
    rerender(<SplitView start={<div>main</div>} end={<div>side</div>} size={0.5} onResizeEnd={onResizeEnd} label="Resize" />);
    const sep = screen.getByRole("separator", { name: "Resize" });
    fireEvent.keyDown(sep, { key: "ArrowLeft" });
    expect(onResizeEnd).toHaveBeenLastCalledWith(0.52);
    fireEvent.keyDown(sep, { key: "ArrowRight", shiftKey: true });
    expect(onResizeEnd.mock.calls.at(-1)![0]).toBeCloseTo(0.4);
    rerender(<SplitView start={<div>main</div>} end={<div>side</div>} size={0.8} onResizeEnd={onResizeEnd} />);
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
    expect(onResizeEnd).toHaveBeenLastCalledWith(0.8);
  });
});
