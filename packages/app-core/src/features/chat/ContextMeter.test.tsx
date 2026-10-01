import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/preact";
import type { HarnessUsageLimits, ModelRef, UsageLimits } from "@glade/protocol";
import { usageLimits, type ChatUsageEntry } from "@glade/app-core/state/usage";
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
/** One agent's entry as the popover gets it. */
const mine = (u: UsageLimits, over: Partial<ChatUsageEntry> = {}): ChatUsageEntry[] => [{ harnessId: "pi", label: "Pi", usage: u, mine: true, ...over }];
const codex: HarnessUsageLimits = {
  harnessId: "codex",
  label: "Codex",
  usage: {
    source: "Codex (plus)",
    provider: "codex",
    fetchedAt: NOW - 60 * 60_000,
    stale: false,
    limits: [
      { id: "primary", label: "5-hour limit", percent: 12, resetsAt: null, severity: "normal", active: false },
      { id: "secondary", label: "This week", percent: 40, resetsAt: null, severity: "normal", active: true },
    ],
  },
};
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
    render(<UsageDetails usage={usage} cost={0.42} limits={[]} now={NOW} />);
    const el = screen.getByTestId("context-meter-details");
    expect(bars(el)).toEqual([["Context window", "4"]]);
    expect(el.textContent).toContain("8.7k / 200k tokens");
    expect(el.textContent).toContain("Session cost$0.42");
    expect(el.textContent).not.toMatch(/compact/i);
    expect(el.querySelector("[data-testid='usage-limits']")).toBeNull();
  });

  it("shows an empty bar with a hint while the size is unknown, and the compaction state", () => {
    const unknown = { tokens: null, contextWindow: 200_000, percent: null };
    const { rerender } = render(<UsageDetails usage={unknown} limits={[]} />);
    const el = screen.getByTestId("context-meter-details");
    expect(bars(el)).toEqual([["Context window", null]]);
    expect(el.textContent).toContain("updates after the next reply");
    rerender(<UsageDetails usage={usage} compacting limits={[]} />);
    expect(el.textContent).toContain("Compacting…");
  });

  it("adds every limit as a bar with reset times, severity colours and the update time", () => {
    const { container } = render(<UsageDetails usage={usage} limits={mine(limits({ stale: true }))} model={sonnet} now={NOW} />);
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
    const { container, rerender } = render(<UsageDetails usage={usage} limits={mine(calm)} model={fable} now={NOW} />);
    const row = () => container.querySelector("[data-limit-id='weekly_scoped:Fable']")!;
    expect(row().textContent).toContain("this model");
    expect(row().className).not.toContain("opacity-60");
    rerender(<UsageDetails usage={usage} limits={mine(calm)} model={sonnet} now={NOW} />);
    expect(row().textContent).not.toContain("this model");
    expect(row().className).toContain("opacity-60");
  });
});

describe("ContextMeter", () => {
  afterEach(() => {
    usageLimits.value = new Map();
  });

  const open = async (model: ModelRef | null, harnessId: string | null = "pi") => {
    render(<ContextMeter usage={usage} cost={0.42} model={model} harnessId={harnessId} />);
    const trigger = screen.getByRole("button", { name: "Context usage: 8.7k / 200k tokens (4%)" });
    expect(trigger.getAttribute("data-level")).toBe("normal");
    fireEvent.click(trigger);
    return screen.findByRole("dialog");
  };
  const groups = (el: HTMLElement) => [...el.querySelectorAll("[data-testid='usage-agent']")].map((g) => `${g.getAttribute("data-harness")}${g.textContent!.includes("This chat") ? "*" : ""}`);

  it("opens a popover on click with every agent's limits, the chat's own first", async () => {
    usageLimits.value = new Map([["", [{ harnessId: "pi", label: "Pi", usage: limits() }, codex]]]);
    const dialog = await open(sonnet);
    expect(bars(dialog).map(([label]) => label)).toEqual(["Context window", "Current session", "This week", "Fable this week", "5-hour limit", "This week"]);
    expect(groups(dialog)).toEqual(["pi*", "codex"]);
    expect(dialog.textContent).toContain("Codex (plus)");
  });

  it("I-191: a Codex chat shows Codex's limits first", async () => {
    usageLimits.value = new Map([["", [{ harnessId: "pi", label: "Pi", usage: limits() }, codex]]]);
    const dialog = await open({ provider: "codex", id: "gpt-6" }, "codex");
    expect(groups(dialog)).toEqual(["codex*", "pi"]);
  });

  it("doesn't call another provider's limits the chat's own", async () => {
    usageLimits.value = new Map([["", [{ harnessId: "pi", label: "Pi", usage: limits() }]]]);
    const dialog = await open(gpt);
    expect(groups(dialog)).toEqual(["pi"]);
    expect(dialog.querySelector("[data-limit-id='weekly_scoped:Fable']")!.textContent).not.toContain("this model");
  });

  it("shows the limits of the Mac the chat runs on", async () => {
    usageLimits.value = new Map([["", [{ harnessId: "pi", label: "Pi", usage: limits() }]], ["MAC-B", [codex]]]);
    render(<ContextMeter usage={usage} model={sonnet} harnessId="codex" envId="MAC-B" />);
    fireEvent.click(screen.getByRole("button", { name: /Context usage/ }));
    const dialog = await screen.findByRole("dialog");
    expect(groups(dialog)).toEqual(["codex"]);
  });

  it("reports opening and closing (the touch composer stays expanded meanwhile)", async () => {
    const onOpenChange = vi.fn();
    const { unmount } = render(<ContextMeter usage={usage} model={sonnet} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Context usage/ }));
    await screen.findByRole("dialog");
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    unmount();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("shows only the context without any limits", async () => {
    const dialog = await open(sonnet);
    expect(bars(dialog)).toEqual([["Context window", "4"]]);
    expect(groups(dialog)).toEqual([]);
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
