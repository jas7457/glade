/** Plans as checklist cards in the transcript (I-119). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import { defaultSessionState, type ChatMessage, type PlanEntry } from "@glade/protocol";
import { TooltipProvider } from "@glade/app-core/ui";
import { sessions } from "@glade/app-core/state/store";
import { getChatSession, resetChatSessions } from "@glade/app-core/state/chat-session";
import { makeSession } from "@glade/app-core/test/fixtures";
import { Transcript } from "./Transcript";
import { planPreview } from "./PlanCard";

vi.mock("@glade/app-core/lib/api", () => ({ api: { getSession: vi.fn(() => new Promise(() => {})) } }));
vi.mock("@glade/app-core/lib/socket", () => ({ socket: { send: vi.fn(), watch: vi.fn(() => () => {}) } }));
Element.prototype.scrollTo = vi.fn() as unknown as Element["scrollTo"];

const steps = (statuses: PlanEntry["status"][]): PlanEntry[] => statuses.map((status, i) => ({ content: `Step ${i + 1}`, status }));
const planMessage = (plan: PlanEntry[]): ChatMessage => ({ id: "plan1", role: "notice", kind: "plan", text: "Plan", plan, timestamp: 1 });

beforeEach(() => {
  resetChatSessions();
  sessions.value = [makeSession({ id: "c1" })];
});

describe("planPreview", () => {
  it("shows short plans whole and long ones around the first unfinished step", () => {
    expect(planPreview(steps(["completed", "pending"])).items).toHaveLength(2);
    const long = steps(["completed", "completed", "completed", "in_progress", "pending", "pending", "pending", "pending"]);
    expect(planPreview(long)).toMatchObject({ start: 2 });
    expect(planPreview(long).items.map((e) => e.content)).toEqual(["Step 3", "Step 4", "Step 5", "Step 6", "Step 7"]);
    expect(planPreview(steps(Array(8).fill("pending"))).start).toBe(0);
    expect(planPreview(steps(Array(8).fill("completed"))).start).toBe(3);
  });
});

describe("PlanCard in the transcript", () => {
  it("renders a plan notice as a checklist, updates it in place, collapses long plans", () => {
    const store = getChatSession("c1");
    store.status.value = "ready";
    store.state.value = defaultSessionState();
    store.transcript.value = { messages: [planMessage(steps(["in_progress", "pending"]))], toolResults: {} };
    const { container } = render(
      <TooltipProvider>
        <Transcript chatId="c1" />
      </TooltipProvider>,
    );
    const card = () => container.querySelector('[data-role="plan"]') as HTMLElement;
    expect(container.querySelector('[data-role="notice"]')).toBeNull();
    expect(card().textContent).toContain("0 of 2 done");
    expect([...card().querySelectorAll("li")].map((li) => li.getAttribute("data-status"))).toEqual(["in_progress", "pending"]);
    expect(screen.getByRole("img", { name: "In progress" })).toBeTruthy();

    // The same message id with a new plan updates the card.
    store.transcript.value = { messages: [planMessage(steps(["completed", "completed", "in_progress", "pending", "pending", "pending", "pending"]))], toolResults: {} };
    return Promise.resolve().then(() => {
      expect(container.querySelectorAll('[data-role="plan"]')).toHaveLength(1);
      expect(card().textContent).toContain("2 of 7 done");
      expect(card().querySelectorAll("li")).toHaveLength(5);
      fireEvent.click(screen.getByRole("button", { name: "Show all (7)" }));
      expect(card().querySelectorAll("li")).toHaveLength(7);
      fireEvent.click(screen.getByRole("button", { name: "Show less" }));
      expect(card().querySelectorAll("li")).toHaveLength(5);
    });
  });
});
