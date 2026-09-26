import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/preact";
import type { UsageLimits } from "@pi-ui/protocol";
import { usageLimits } from "@/state/usage";
import { TooltipProvider } from "@/ui";
import { ContextMeter, ContextMeterDetails, LimitLines } from "./ContextMeter";

const NOW = new Date(2026, 8, 25, 14, 0).getTime();
const limits = (over: Partial<UsageLimits> = {}): UsageLimits => ({
  source: "Claude subscription",
  fetchedAt: NOW,
  stale: false,
  limits: [
    { id: "session", label: "Current session", percent: 52, resetsAt: new Date(2026, 8, 25, 18, 40).toISOString(), severity: "normal", active: true },
    { id: "weekly_all", label: "This week", percent: 7, resetsAt: new Date(2026, 8, 26, 12, 0).toISOString(), severity: "normal", active: false },
    { id: "weekly_scoped:Fable", label: "Fable this week", percent: 97, resetsAt: null, severity: "critical", active: false },
  ],
  ...over,
});
const usage = { tokens: 8_700, contextWindow: 200_000, percent: 4.35 };

const details = (limits: UsageLimits | null) =>
  render(<ContextMeterDetails usage={usage} cost={0.42} limits={limits} />).getByTestId("context-meter-details");

describe("ContextMeterDetails", () => {
  it("shows tokens, percentage and cost, without the compaction hint or limits when unavailable", () => {
    const el = details(null);
    expect(el.textContent).toContain("Context: 8.7k / 200k tokens (4%)");
    expect(el.textContent).toContain("Session cost: $0.42");
    expect(el.textContent).not.toMatch(/compact/i);
    expect(el.querySelector("[data-testid='context-meter-limits']")).toBeNull();
  });

  it("adds the subscription limits when available", () => {
    const el = details(limits());
    expect(el.textContent).toContain("Claude subscription");
    expect(el.querySelector("[data-limit-id='session']")!.textContent).toMatch(/^Current session 52% · resets at/);
  });
});

describe("ContextMeter", () => {
  afterEach(() => {
    usageLimits.value = null;
  });

  it("renders the ring trigger with the usage summary", () => {
    usageLimits.value = limits();
    render(
      <TooltipProvider>
        <ContextMeter usage={usage} />
      </TooltipProvider>,
    );
    expect(screen.getByRole("button", { name: "Context usage: 8.7k / 200k tokens (4%)" }).getAttribute("data-level")).toBe("normal");
  });
});

describe("LimitLines", () => {
  it("formats each limit with its reset time and severity colour", () => {
    const { container } = render(<LimitLines usage={limits({ stale: true })} now={NOW} />);
    const line = (id: string) => container.querySelector(`[data-limit-id='${id}']`)!;
    expect(line("session").textContent).toBe("Current session 52% · resets at 6:40 PM");
    expect(line("weekly_all").textContent).toBe("This week 7% · resets Saturday 12:00 PM");
    expect(line("weekly_scoped:Fable").textContent).toBe("Fable this week 97%");
    expect(line("weekly_scoped:Fable").className).toContain("text-danger");
    expect(container.textContent).toContain("may be out of date");
  });
});
