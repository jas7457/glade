import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/preact";
import { StatusIndicator, statusLabel } from "./StatusIndicator";
import { TooltipProvider } from "./Tooltip";

const renderStatus = (props: Parameters<typeof StatusIndicator>[0]) =>
  render(
    <TooltipProvider>
      <StatusIndicator {...props} />
    </TooltipProvider>,
  );

describe("StatusIndicator", () => {
  it("renders nothing visible for idle but reserves space", () => {
    const { container } = renderStatus({ status: "idle" });
    const box = container.querySelector("[data-status=idle]") as HTMLElement;
    expect(box).toBeTruthy();
    expect(box.childElementCount).toBe(0);
    expect(box.style.width).toBe("14px");
  });
  it("shows a spinner while working", () => {
    renderStatus({ status: "working" });
    expect(screen.getByRole("img", { name: "Working…" }).querySelector("svg")).toBeTruthy();
  });
  it("shows an accent dot for unread and a red one for failures", () => {
    const { container, rerender } = renderStatus({ status: "unread" });
    expect(screen.getByRole("img", { name: "New messages" })).toBeTruthy();
    expect(container.querySelector(".bg-accent")).toBeTruthy();
    rerender(
      <TooltipProvider>
        <StatusIndicator status="unread" failed />
      </TooltipProvider>,
    );
    expect(screen.getByRole("img", { name: "Last run failed" })).toBeTruthy();
    expect(container.querySelector(".bg-danger")).toBeTruthy();
  });
  it("shows an attention badge when blocked", () => {
    renderStatus({ status: "blocked" });
    expect(screen.getByRole("img", { name: "Needs your input" }).textContent).toContain("!");
  });
  it("labels", () => {
    expect(statusLabel("idle")).toBeNull();
    expect(statusLabel("working")).toBe("Working…");
  });
});
