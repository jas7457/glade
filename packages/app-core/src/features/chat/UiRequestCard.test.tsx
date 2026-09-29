/** Permission requests from ACP agents (I-119) and Claude Code (numbered, I-174) in the dialog card. */
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

const CLAUDE: UiRequest = {
  id: "perm-2",
  kind: "permission",
  title: "Allow Bash?",
  message: "$ npm test",
  numbered: true,
  options: [
    { id: "allow", label: "Yes", kind: "allow_once" },
    { id: "allow_always", label: "Yes, and don't ask again for npm test commands in ~/app", kind: "allow_always" },
    { id: "reject", label: "No, and tell Claude what to do differently", kind: "reject_once", focusComposer: true },
  ],
};

describe("numbered permission card (Claude Code, I-174)", () => {
  it("lists the options in the agent's order with numbers; keys 1-3 pick", () => {
    const onRespond = vi.fn();
    render(<UiRequestCard request={CLAUDE} onRespond={onRespond} />);
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["1Yes", "2Yes, and don't ask again for npm test commands in ~/app", "3No, and tell Claude what to do differentlyesc"]);
    expect(document.activeElement?.textContent).toBe("1Yes");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "2" });
    expect(onRespond).toHaveBeenCalledWith({ id: "perm-2", value: "allow_always" });
  });

  it("No and Esc hand back to the user: the composer gets the focus", () => {
    const onRespond = vi.fn();
    const onFocusComposer = vi.fn();
    render(<UiRequestCard request={CLAUDE} onRespond={onRespond} onFocusComposer={onFocusComposer} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onRespond).toHaveBeenCalledWith({ id: "perm-2", value: "reject" });
    expect(onFocusComposer).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("option", { name: /^3No/ }));
    expect(onFocusComposer).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("option", { name: /^1Yes$/ }));
    expect(onFocusComposer).toHaveBeenCalledTimes(2);
  });

  it("opens on No without number keys when the agent says a stray key mustn't approve", () => {
    const onRespond = vi.fn();
    render(<UiRequestCard request={{ ...CLAUDE, defaultOptionId: "reject" }} onRespond={onRespond} />);
    expect(document.activeElement?.textContent).toMatch(/^3No/);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "1" });
    expect(onRespond).not.toHaveBeenCalled();
  });
});
