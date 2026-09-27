/** CommandPalette: status glyphs stay readable on the highlighted row (I-060). */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/preact";
import { CommandPalette } from "./CommandPalette";
import { StatusIndicator } from "./StatusIndicator";

Element.prototype.scrollTo ??= function () {};

describe("CommandPalette", () => {
  it("restyles status glyphs only on the highlighted row", () => {
    render(
      <CommandPalette
        open
        onOpenChange={() => {}}
        query=""
        onQueryChange={() => {}}
        onRun={() => {}}
        sections={[
          {
            title: "Chats",
            items: [
              { id: "a", title: "Alpha", icon: <StatusIndicator status="unread" tooltip={false} /> },
              { id: "b", title: "Beta", icon: <StatusIndicator status="unread" tooltip={false} /> },
            ],
          },
        ]}
      />,
    );
    const [a, b] = screen.getAllByRole("option");
    expect(a!.getAttribute("aria-selected")).toBe("true");
    const iconBox = (row: HTMLElement) => row.querySelector("[data-status]")!.parentElement!;
    expect(iconBox(a!).className).toContain("[&_[data-status=unread]>.bg-accent]:bg-accent-fg");
    expect(iconBox(a!).className).toContain("shadow-[0_0_0_1.5px_var(--color-accent-fg)]");
    expect(iconBox(b!).className).not.toContain("data-status");
  });
});
