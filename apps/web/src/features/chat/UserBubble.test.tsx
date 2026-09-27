import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import type { UserMessage } from "@glade/protocol";
import { UserBubble } from "./UserBubble";

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
});
