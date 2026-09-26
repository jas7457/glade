import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/preact";
import type { UsageLimits } from "@pi-ui/protocol";
import { usageLimits } from "@/state/usage";
import { UsageGauge, UsagePanel } from "./UsageGauge";

const NOW = new Date(2026, 8, 25, 14, 0).getTime();
const sample = (over: Partial<UsageLimits> = {}): UsageLimits => ({
  source: "Claude subscription",
  fetchedAt: NOW - 2 * 60_000,
  stale: false,
  limits: [
    { id: "session", label: "Current session", percent: 44, resetsAt: new Date(2026, 8, 25, 18, 40).toISOString(), severity: "normal", active: true },
    { id: "weekly_all", label: "This week", percent: 6, resetsAt: new Date(2026, 8, 26, 12, 0).toISOString(), severity: "normal", active: false },
    { id: "weekly_scoped:Fable", label: "Fable this week", percent: 82, resetsAt: null, severity: "warning", active: false },
  ],
  ...over,
});

describe("UsageGauge", () => {
  beforeEach(() => {
    usageLimits.value = null;
  });

  it("renders nothing when limits are unavailable", () => {
    const { container } = render(<UsageGauge />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the most constraining limit and opens a popover with every limit", async () => {
    usageLimits.value = sample();
    render(<UsageGauge />);
    const trigger = screen.getByRole("button", { name: /Fable this week 82% used/ });
    expect(trigger.textContent).toBe("82%");
    expect(trigger.getAttribute("data-severity")).toBe("warning");
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    const bars = within(dialog).getAllByRole("progressbar");
    expect(bars.map((b) => [b.getAttribute("aria-label"), b.getAttribute("aria-valuenow")])).toEqual([
      ["Current session", "44"],
      ["This week", "6"],
      ["Fable this week", "82"],
    ]);
    expect(within(dialog).getByText("44% used")).toBeTruthy();
  });
});

describe("UsagePanel", () => {
  it("formats resets, the update time and the stale hint", () => {
    const { container } = render(<UsagePanel usage={sample({ stale: true })} now={NOW} />);
    const text = container.textContent!.replace(/\s/g, " ");
    expect(text).toContain("Resets at 6:40 PM");
    expect(text).toContain("Resets Saturday 12:00 PM");
    expect(text).toContain("Updated 2 min ago · may be out of date");
    expect(container.querySelector("[data-limit-id='weekly_scoped:Fable'] .bg-warning")).toBeTruthy();
  });
});
