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

  it("sizes tabs to their content (capped) and marks the active one", () => {
    render(<TabStrip label="Tabs" tabs={tabs} activeId="a" onSelect={() => {}} onClose={() => {}} />);
    const [a, b] = screen.getAllByRole("tab");
    for (const tab of [a!, b!]) {
      expect(tab.className).toContain("max-w-[220px]");
      expect(tab.className).not.toMatch(/\bbasis-\[/);
      expect(tab.querySelector("span.truncate")!.className).not.toContain("flex-1");
    }
    // Active: accent line on top, window background, full-strength text; inactive: muted.
    expect(a!.className).toContain("before:bg-accent");
    expect(a!.className).toContain("bg-window");
    expect(a!.className).toContain("text-fg ");
    expect(b!.className).not.toContain("before:bg-accent");
    expect(b!.className).toContain("text-fg-muted");
    // The close button keeps its space on inactive tabs (hidden, not removed).
    expect(screen.getByRole("button", { name: "Close Beta" }).className).toContain("opacity-0");
  });

  it("shows an optional badge after the title and a custom tooltip", () => {
    const withBadge = [{ id: "a", title: "Alpha", status: "idle" as const, badge: <span data-testid="done">✓</span>, tooltip: "Alpha — done" }, tabs[1]!];
    render(<TabStrip label="Tabs" tabs={withBadge} activeId="a" onSelect={() => {}} onClose={() => {}} />);
    const [a, b] = screen.getAllByRole("tab");
    const badge = screen.getByTestId("done");
    expect(a!.contains(badge)).toBe(true);
    // After the title, before the close button.
    expect(a!.textContent).toBe("Alpha✓");
    expect(badge.compareDocumentPosition(screen.getByRole("button", { name: "Close Alpha" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(a!.getAttribute("title")).toBe("Alpha — done");
    expect(b!.getAttribute("title")).toBe("Beta");
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
