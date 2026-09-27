/** SearchPopover (I-105): filtering, persistent rows, keyboard navigation skipping disabled rows. */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import { SearchPopover, matchesQuery } from "./SearchPopover";

describe("SearchPopover", () => {
  it("filters by label/keywords, keeps persistent rows, ↓/Return skip disabled rows", () => {
    const onSelect = vi.fn();
    render(
      <SearchPopover
        label="Things"
        onSelect={onSelect}
        trigger={<button type="button">Open</button>}
        sections={[
          { items: [{ id: "a", label: "alpha" }, { id: "b", label: "beta", disabled: true }, { id: "c", label: "gamma", keywords: ["third"] }] },
          { items: [{ id: "new", label: "New…", persistent: true }] },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const field = screen.getByRole("combobox");
    expect(screen.getAllByRole("option")).toHaveLength(4);
    fireEvent.keyDown(field, { key: "ArrowDown" }); // alpha → (beta disabled) → gamma
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("c");
    expect(screen.queryByRole("listbox")).toBeNull(); // closed

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.input(screen.getByRole("combobox"), { target: { value: "third" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["gamma", "New…"]);
    fireEvent.input(screen.getByRole("combobox"), { target: { value: "zzz" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["New…"]);
  });

  it("matchesQuery is case-insensitive", () => {
    expect(matchesQuery({ id: "x", label: "Main" }, "mA")).toBe(true);
    expect(matchesQuery({ id: "x", label: "Main" }, "dev")).toBe(false);
  });
});
