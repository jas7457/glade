/** Permission requests from ACP agents (I-119) in the dialog card. */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import type { UiRequest } from "@glade/protocol";
import { UiRequestCard, permissionOrder } from "./UiRequestCard";

const REQUEST: UiRequest = {
  id: "perm-1",
  kind: "permission",
  title: "Delete build/",
  message: "$ rm -rf build",
  toolCallId: "p1",
  options: [
    { id: "allow", label: "Allow once", kind: "allow_once" },
    { id: "always", label: "Always allow", kind: "allow_always" },
    { id: "reject", label: "Reject", kind: "reject_once" },
  ],
};

describe("permission card", () => {
  it("shows the tool call and the agent's options, allow once as the default", () => {
    const onRespond = vi.fn();
    render(<UiRequestCard request={REQUEST} onRespond={onRespond} />);
    expect(screen.getByText("The agent asks for permission")).toBeTruthy();
    expect(screen.getByText("Delete build/")).toBeTruthy();
    expect(screen.getByText("$ rm -rf build")).toBeTruthy();
    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(["Reject", "Always allow", "Allow once"]);
    expect(document.activeElement?.textContent).toBe("Allow once");
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    expect(onRespond).toHaveBeenCalledWith({ id: "perm-1", value: "always" });
  });

  it("Escape cancels", () => {
    const onRespond = vi.fn();
    render(<UiRequestCard request={REQUEST} onRespond={onRespond} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onRespond).toHaveBeenCalledWith({ id: "perm-1", cancelled: true });
  });

  it("orders rejections first and allow once last", () => {
    const kinds = permissionOrder([
      { id: "a", label: "A", kind: "allow_once" },
      { id: "b", label: "B", kind: "reject_always" },
      { id: "c", label: "C", kind: "allow_always" },
      { id: "d", label: "D", kind: "reject_once" },
    ]).map((o) => o.id);
    expect(kinds).toEqual(["b", "d", "c", "a"]);
  });
});
