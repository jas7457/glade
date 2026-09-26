import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import { SidebarGroup, SidebarList } from "./Sidebar";
import { SidebarItem } from "./SidebarItem";

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
});
