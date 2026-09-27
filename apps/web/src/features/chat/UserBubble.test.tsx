import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import type { UserMessage } from "@glade/protocol";
import { UserBubble } from "./UserBubble";
import { stubLayout } from "@/test/layout-stub";

vi.mock("@/lib/api", () => ({ api: { revealFile: vi.fn(async () => undefined) } }));
const { api } = await import("@/lib/api");

const user = (text: string): UserMessage => ({ id: "u1", role: "user", content: [{ type: "text", text }], timestamp: 0 });

describe("UserBubble", () => {
  it("shows Attached file lines as file chips (tooltip = path, click reveals)", () => {
    const { container } = render(
      <UserBubble message={user("Summarise these\n\nAttached file: /data/attachments/s1/report.pdf\nAttached file: /data/attachments/s1/data.csv")} />,
    );
    expect(container.textContent).not.toContain("Attached file:");
    expect(screen.getByText("Summarise these")).toBeTruthy();
    const chip = screen.getByText("report.pdf").closest("[data-chip]")!;
    expect(chip.getAttribute("title")).toBe("/data/attachments/s1/report.pdf");
    expect(screen.getByText("data.csv")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /report\.pdf/ }));
    expect(api.revealFile).toHaveBeenCalledWith("/data/attachments/s1/report.pdf");
  });

  it("files only: no empty text bubble", () => {
    const { container } = render(<UserBubble message={user("Attached file: /x/y/notes.txt")} />);
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect(container.querySelector(".bg-selected")).toBeNull();
  });

  it("renders @ mentions as inline path chips, keeping the rest of the text", () => {
    const { container } = render(<UserBubble message={user('Compare @src/app.ts with @"my docs/read me.md" in @lib/ please, me@example.com')} />);
    const chips = [...container.querySelectorAll('[data-chip="inline"]')];
    expect(chips.map((c) => c.textContent)).toEqual(["src/app.ts", "my docs/read me.md", "lib/"]);
    expect(chips[0]!.getAttribute("title")).toBe("File: src/app.ts");
    expect(chips[2]!.getAttribute("title")).toBe("Folder: lib");
    expect(container.textContent).toContain("please, me@example.com");
    expect(container.textContent?.startsWith("Compare ")).toBe(true);
  });

  it("collapses text longer than 15 lines with Show more / Show less", () => {
    const restore = stubLayout();
    try {
      const { unmount } = render(<UserBubble message={user(Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"))} />);
      expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
      unmount();
      render(<UserBubble message={user(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"))} />);
      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
      expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
    } finally {
      restore();
    }
  });

  it("shows its time on hover, with the full date as the tooltip", () => {
    const { container } = render(<UserBubble message={{ ...user("hi"), timestamp: new Date(2026, 8, 27, 14, 32, 5).getTime() }} />);
    const time = container.querySelector("time")!;
    expect(time.textContent).toMatch(/2:32|14:32/);
    expect(time.getAttribute("title")).toMatch(/2026/);
    expect(time.className).toContain("group-hover/msg:opacity-100");
  });

  it("opens an attached image in the lightbox; arrows move between the message's images", () => {
    const message: UserMessage = {
      id: "u1",
      role: "user",
      content: [
        { type: "image", mimeType: "image/png", data: "AAA" },
        { type: "image", mimeType: "image/jpeg", data: "BBB" },
        { type: "text", text: "look" },
      ],
      timestamp: 0,
    };
    render(<UserBubble message={message} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Open image" })[1]!);
    const box = screen.getByTestId("lightbox");
    expect(box.querySelector("img")!.getAttribute("src")).toBe("data:image/jpeg;base64,BBB");
    fireEvent.keyDown(box, { key: "ArrowRight" });
    expect(box.querySelector("img")!.getAttribute("src")).toBe("data:image/png;base64,AAA");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByTestId("lightbox")).toBeNull();
  });
});
