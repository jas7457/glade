import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/preact";
import type { ModelRef, UsageLimits } from "@pi-ui/protocol";
import { usageLimits } from "@/state/usage";
import { ContextMeter } from "./ContextMeter";
import { UsageDetails } from "./usage/UsageDetails";

const NOW = new Date(2026, 8, 25, 14, 0).getTime();
const limits = (over: Partial<UsageLimits> = {}): UsageLimits => ({
  source: "Claude subscription",
  provider: "anthropic",
  fetchedAt: NOW - 2 * 60_000,
  stale: false,
  limits: [
    { id: "session", label: "Current session", percent: 52, resetsAt: new Date(2026, 8, 25, 18, 40).toISOString(), severity: "normal", active: true },
    { id: "weekly_all", label: "This week", percent: 7, resetsAt: new Date(2026, 8, 26, 12, 0).toISOString(), severity: "normal", active: false },
    { id: "weekly_scoped:Fable", label: "Fable this week", percent: 97, resetsAt: null, severity: "critical", active: false, model: "Fable" },
  ],
  ...over,
});
const usage = { tokens: 8_700, contextWindow: 200_000, percent: 4.35 };
const sonnet: ModelRef = { provider: "anthropic", id: "claude-sonnet-4-5" };
const fable: ModelRef = { provider: "anthropic", id: "claude-fable-1" };
const gpt: ModelRef = { provider: "openai", id: "gpt-5" };

const bars = (el: HTMLElement) =>
  within(el)
    .getAllByRole("progressbar")
    .map((b) => [b.getAttribute("aria-label"), b.getAttribute("aria-valuenow")]);

describe("UsageDetails", () => {
  it("shows a context bar and the session cost, without limits when unavailable", () => {
    render(<UsageDetails usage={usage} cost={0.42} limits={null} now={NOW} />);
    const el = screen.getByTestId("context-meter-details");
    expect(bars(el)).toEqual([["Context window", "4"]]);
    expect(el.textContent).toContain("8.7k / 200k tokens");
    expect(el.textContent).toContain("Session cost$0.42");
    expect(el.textContent).not.toMatch(/compact/i);
    expect(el.querySelector("[data-testid='usage-limits']")).toBeNull();
  });

  it("shows an empty bar with a hint while the size is unknown, and the compaction state", () => {
    const unknown = { tokens: null, contextWindow: 200_000, percent: null };
    const { rerender } = render(<UsageDetails usage={unknown} limits={null} />);
    const el = screen.getByTestId("context-meter-details");
    expect(bars(el)).toEqual([["Context window", null]]);
    expect(el.textContent).toContain("updates after the next reply");
    rerender(<UsageDetails usage={usage} compacting limits={null} />);
    expect(el.textContent).toContain("Compacting…");
  });

  it("adds every limit as a bar with reset times, severity colours and the update time", () => {
    const { container } = render(<UsageDetails usage={usage} limits={limits({ stale: true })} model={sonnet} now={NOW} />);
    const el = screen.getByTestId("context-meter-details");
    expect(bars(el)).toEqual([
      ["Context window", "4"],
      ["Current session", "52"],
      ["This week", "7"],
      ["Fable this week", "97"],
    ]);
    const text = el.textContent!.replace(/\s/g, " ");
    expect(text).toContain("Claude subscription");
    expect(text).toContain("52% used");
    expect(text).toContain("Resets at 6:40 PM");
    expect(text).toContain("Resets Saturday 12:00 PM");
    expect(text).toContain("Updated 2 min ago · may be out of date");
    expect(container.querySelector("[data-limit-id='weekly_scoped:Fable'] .bg-danger")).toBeTruthy();
    expect(text).not.toContain("this model");
  });

  it("tags the per-model limit of the chat's model and dims other models' limits", () => {
    const calm = limits();
    calm.limits[2] = { ...calm.limits[2]!, percent: 10, severity: "normal" };
    const { container, rerender } = render(<UsageDetails usage={usage} limits={calm} model={fable} now={NOW} />);
    const row = () => container.querySelector("[data-limit-id='weekly_scoped:Fable']")!;
    expect(row().textContent).toContain("this model");
    expect(row().className).not.toContain("opacity-60");
    rerender(<UsageDetails usage={usage} limits={calm} model={sonnet} now={NOW} />);
    expect(row().textContent).not.toContain("this model");
    expect(row().className).toContain("opacity-60");
  });
});

describe("ContextMeter", () => {
  afterEach(() => {
    usageLimits.value = null;
  });

  const open = async (model: ModelRef | null) => {
    render(<ContextMeter usage={usage} cost={0.42} model={model} />);
    const trigger = screen.getByRole("button", { name: "Context usage: 8.7k / 200k tokens (4%)" });
    expect(trigger.getAttribute("data-level")).toBe("normal");
    fireEvent.click(trigger);
    return screen.findByRole("dialog");
  };

  it("opens a popover on click with the limits for the model's provider", async () => {
    usageLimits.value = limits();
    const dialog = await open(sonnet);
    expect(bars(dialog).map(([label]) => label)).toEqual(["Context window", "Current session", "This week", "Fable this week"]);
  });

  it("hides the limits for other providers' models (and without a model)", async () => {
    usageLimits.value = limits();
    const dialog = await open(gpt);
    expect(bars(dialog)).toEqual([["Context window", "4"]]);
    expect(dialog.textContent).not.toContain("Claude subscription");
  });

  it("opens on hover and a click pins it open", async () => {
    render(<ContextMeter usage={usage} model={sonnet} />);
    const trigger = screen.getByRole("button", { name: /Context usage/ });
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    const dialog = await screen.findByRole("dialog", {}, { timeout: 1000 });
    expect(dialog).toBeTruthy();
    fireEvent.click(trigger);
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(screen.queryByRole("dialog")).toBeTruthy();
  });

  it("renders nothing without usage", () => {
    const { container } = render(<ContextMeter usage={undefined} />);
    expect(container.innerHTML).toBe("");
  });
});
