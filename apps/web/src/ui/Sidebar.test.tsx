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
  it("hides the trailing indicators while hovered or while actions are pinned visible", () => {
    const { container, rerender } = render(<SidebarItem label="Title" trailing="5m" actions={<button type="button">More</button>} />);
    const trailing = container.querySelector("[data-slot=trailing]") as HTMLElement;
    expect(trailing.textContent).toBe("5m");
    expect(trailing.className).toContain("group-hover/item:invisible");
    expect(trailing.className).not.toMatch(/(^| )invisible( |$)/);
    rerender(<SidebarItem label="Title" trailing="5m" actions={<button type="button">More</button>} actionsVisible />);
    expect((container.querySelector("[data-slot=trailing]") as HTMLElement).className).toMatch(/(^| )invisible( |$)/);
  });

  it("keeps the trailing indicators on hover when there are no actions", () => {
    const { container } = render(<SidebarItem label="Title" trailing="⌘N" />);
    expect((container.querySelector("[data-slot=trailing]") as HTMLElement).className).not.toContain("invisible");
  });

  it("indents the content by level on the header-aligned grid", () => {
    render(
      <>
        <SidebarItem label="Plain" />
        <SidebarItem label="Nested" indent={1} />
      </>,
    );
    const button = (name: string) => screen.getByRole("button", { name: new RegExp(name) });
    expect(button("Plain").className).toContain(sidebarClass.inset[0]);
    expect(button("Nested").className).toContain(sidebarClass.inset[1]);
    // Indent 0 is flush with the header text (px-2); indent 1 is where a label starts after an icon.
    expect(SIDEBAR_METRICS.inset).toEqual([8, 32]);
    expect(SIDEBAR_METRICS.inset[0] + SIDEBAR_METRICS.iconWidth + SIDEBAR_METRICS.iconGap).toBe(SIDEBAR_METRICS.inset[1]);
  });
});
