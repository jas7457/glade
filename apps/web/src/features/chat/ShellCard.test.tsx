import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import type { ShellMessage } from "@glade/protocol";
import { TooltipProvider } from "@/ui";
import { ShellCard, shellPreview } from "./ShellCard";

vi.mock("@/lib/api", () => ({ api: { abortShell: vi.fn(async () => undefined) } }));
const { api } = await import("@/lib/api");

const base: ShellMessage = {
  id: "s1",
  role: "shell",
  command: "ls -la",
  output: "a.txt\nb.txt\n",
  exitCode: 0,
  cancelled: false,
  truncated: false,
  shared: true,
  running: false,
  timestamp: 1000,
  endedAt: 1200,
};

function renderCard(message: Partial<ShellMessage> = {}) {
  return render(
    <TooltipProvider>
      <ShellCard message={{ ...base, ...message }} chatId="c1" />
    </TooltipProvider>,
  );
}

describe("shellPreview", () => {
  it("keeps short output and cuts long output to its tail", () => {
    expect(shellPreview("a\nb", 3)).toEqual({ text: "a\nb", hidden: 0 });
    expect(shellPreview("1\n2\n3\n4\n5", 2)).toEqual({ text: "4\n5", hidden: 3 });
  });
});

describe("ShellCard (I-076)", () => {
  it("shows the command and output; no badge or tag for a shared, successful command", () => {
    const { container } = renderCard();
    expect(container.textContent).toContain("$ ls -la");
    expect(container.textContent).toContain("a.txt\nb.txt");
    expect(screen.queryByText("Not shared with the agent")).toBeNull();
    expect(screen.queryByLabelText(/Exit code/)).toBeNull();
  });

  it("tags !! commands and shows a non-zero exit code", () => {
    renderCard({ shared: false, exitCode: 2 });
    expect(screen.getByText("Not shared with the agent")).toBeTruthy();
    expect(screen.getByLabelText("Exit code 2").textContent).toBe("exit 2");
  });

  it("offers Stop while running, then copy", async () => {
    const { rerender } = renderCard({ running: true, exitCode: null, output: "partial", endedAt: undefined });
    expect(screen.queryByRole("button", { name: /Copy/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop command" }));
    await waitFor(() => expect(api.abortShell).toHaveBeenCalledWith("c1"));

    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    rerender(
      <TooltipProvider>
        <ShellCard message={{ ...base, cancelled: true, exitCode: null, output: "partial" }} chatId="c1" />
      </TooltipProvider>,
    );
    expect(screen.getByText("Stopped")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy command and output" }));
    expect(writeText).toHaveBeenCalledWith("$ ls -la\npartial");
  });

  it("collapses long output to its last lines until expanded", () => {
    const output = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const { container } = renderCard({ output });
    expect(container.textContent).not.toContain("line 1\n");
    expect(container.textContent).toContain("line 30");
    fireEvent.click(screen.getByRole("button", { name: "Show 18 earlier lines" }));
    expect(container.textContent).toContain("line 1\n");
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
  });

  it("shows (no output) and harness errors", () => {
    const { container, unmount } = renderCard({ output: "" });
    expect(container.textContent).toContain("(no output)");
    unmount();
    const failed = renderCard({ output: "", exitCode: null, error: "pi process is not running" });
    expect(failed.container.textContent).toContain("pi process is not running");
  });
});
