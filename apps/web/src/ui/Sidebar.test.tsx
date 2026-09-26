import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import { SidebarGroup, SidebarList } from "./Sidebar";
import { SidebarItem } from "./SidebarItem";
import { SIDEBAR_METRICS, sidebarClass } from "./sidebar-metrics";

describe("SidebarGroup", () => {
  it("renders a static titled group with its rows", () => {
    render(
      <SidebarGroup title="App">
        <SidebarList>
          <SidebarItem label="General" />
        </SidebarList>
      </SidebarGroup>,
    );
    const group = screen.getByRole("group", { name: "App" });
    expect(group.textContent).toContain("General");
    expect(screen.queryByRole("button", { name: "App" })).toBeNull();
  });

  it("toggles a collapsible group from its header", () => {
    const onOpenChange = vi.fn();
    render(
      <SidebarGroup title="Projects" collapsible onOpenChange={onOpenChange}>
        <SidebarItem label="Alpha" />
      </SidebarGroup>,
    );
    const header = screen.getByRole("button", { name: "Projects" });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Alpha")).toBeTruthy();
    fireEvent.click(header);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Alpha")).toBeNull();
    fireEvent.click(header);
    expect(screen.getByText("Alpha")).toBeTruthy();
  });

  it("renders header actions that don't toggle the group", () => {
    const onAdd = vi.fn();
    render(
      <SidebarGroup
        title="Projects"
        collapsible
        actions={
          <button type="button" onClick={onAdd}>
            Add
          </button>
        }
      >
        <SidebarItem label="Alpha" />
      </SidebarGroup>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onAdd).toHaveBeenCalledOnce();
    expect(screen.getByText("Alpha")).toBeTruthy();
  });

  it("renders an untitled group without a header", () => {
    const { container } = render(
      <SidebarGroup>
        <SidebarItem label="Back" />
      </SidebarGroup>,
    );
    expect(container.querySelector("[role=group]")).toBeNull();
    expect(screen.getByText("Back")).toBeTruthy();
  });
});

describe("SidebarItem", () => {
  it("renders the leading slot before the label and outside the hover-hidden trailing area", () => {
    const { container } = render(<SidebarItem label="Title" leading={<span>L</span>} trailing="5m" actions={<button type="button">More</button>} />);
    const leading = container.querySelector("[data-slot=leading]") as HTMLElement;
    const trailing = container.querySelector("[data-slot=trailing]") as HTMLElement;
    expect(leading.textContent).toBe("L");
    expect(leading.compareDocumentPosition(screen.getByText("Title")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(trailing.contains(leading)).toBe(false);
  });

  it("places the leading slot in the status column and indents the content by level", () => {
    const { container } = render(
      <>
        <SidebarItem label="Plain" />
        <SidebarItem label="Standalone" leading={<span>L</span>} />
        <SidebarItem label="Nested" leading={<span>L</span>} indent={2} />
      </>,
    );
    const button = (name: string) => screen.getByRole("button", { name: new RegExp(name) });
    expect(button("Plain").className).toContain(sidebarClass.inset[0]);
    // A leading slot defaults to indent 1 so the label clears the status column.
    expect(button("Standalone").className).toContain(sidebarClass.inset[1]);
    expect(button("Nested").className).toContain(sidebarClass.inset[2]);
    for (const slot of container.querySelectorAll("[data-slot=leading]")) {
      expect(slot.className).toContain("absolute");
      expect(slot.className).toContain("left-2");
    }
    expect(SIDEBAR_METRICS.inset).toEqual([8, 32, 56]);
    expect(SIDEBAR_METRICS.statusInset + SIDEBAR_METRICS.statusWidth + 8).toBe(SIDEBAR_METRICS.inset[1]);
  });
});
