import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import { defaultSessionState, formatAgentMessage, type ChatMessage } from "@glade/protocol";
import { TooltipProvider } from "@/ui";
import { sessions } from "@/state/store";
import { getChatSession, resetChatSessions } from "@/state/chat-session";
import { makeSession } from "@/test/fixtures";
import { stubLayout } from "@/test/layout-stub";
import { Transcript } from "./Transcript";

vi.mock("@/lib/api", () => ({ api: { getSession: vi.fn(() => new Promise(() => {})) } }));
vi.mock("@/lib/socket", () => ({ socket: { send: vi.fn(), watch: vi.fn(() => () => {}) } }));
Element.prototype.scrollTo = vi.fn() as unknown as Element["scrollTo"];

const user = (id: string, text: string, timestamp = Date.now()): ChatMessage => ({ id, role: "user", content: [{ type: "text", text }], timestamp });
const reply = (id: string, text: string, timestamp = Date.now()): ChatMessage => ({ id, role: "assistant", content: [{ type: "text", text }], timestamp });

function show(chatId: string, messages: ChatMessage[]) {
  const store = getChatSession(chatId);
  store.status.value = "ready";
  store.state.value = defaultSessionState();
  store.transcript.value = { messages, toolResults: {} };
  return render(
    <TooltipProvider>
      <Transcript chatId={chatId} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  resetChatSessions();
  sessions.value = [
    makeSession({ id: "main1", workspaceId: "w1", title: "Refactor the parser" }),
    makeSession({ id: "sub1", workspaceId: "w1", kind: "subagent", parentSessionId: "main1", agentName: "reviewer", agentDisplayName: "Fern", agentColor: "teal" }),
  ];
});

describe("Transcript: a sub-agent's task and its parent's messages (I-109)", () => {
  const task = Array.from({ length: 12 }, (_, i) => `Step ${i + 1}: do something.`).join("\n\n");

  it("shows the task as a collapsed card, parent messages as cards, the user's words as bubbles", () => {
    const restore = stubLayout();
    try {
      const { container } = show("sub1", [
        user("t", task),
        reply("a1", "On it"),
        user("m", formatAgentMessage("main", "Also check the tests")),
        user("u", "I typed this myself"),
      ]);
      const cards = [...container.querySelectorAll('[data-role="delegated"]')];
      expect(cards.map((c) => c.getAttribute("data-kind"))).toEqual(["task", "message"]);
      expect(cards[0]!.textContent).toContain("Task from main · Refactor the parser");
      expect(cards[0]!.getAttribute("data-agent-color")).toBe("teal");
      expect(cards[1]!.textContent).toContain("Message from main");
      expect(cards[1]!.textContent).toContain("Also check the tests");
      expect(cards[1]!.textContent).not.toContain("[agent-teams]");
      expect(container.querySelectorAll('[data-role="user"]')).toHaveLength(1);
      expect(screen.getByText("I typed this myself")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Copy task" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Show full task" }));
      expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("a main chat keeps its first prompt as a bubble", () => {
    const { container } = show("main1", [user("t", "Hello"), reply("a", "Hi")]);
    expect(container.querySelector('[data-role="delegated"]')).toBeNull();
    expect(container.querySelector('[data-role="user"]')).toBeTruthy();
  });
});

describe("Transcript: times and day dividers (I-111)", () => {
  it("puts a divider where the day changes, and a time on each user bubble and reply", () => {
    const day = 24 * 3600 * 1000;
    const now = Date.now();
    const { container } = show("main1", [
      user("u1", "old question", now - 3 * day),
      reply("a1", "old answer", now - 3 * day + 1000),
      user("u2", "yesterday's question", now - day),
      reply("a2", "answer", now - day + 1000),
      user("u3", "today's question", now),
    ]);
    const dividers = [...container.querySelectorAll('[data-aux="day"]')].map((d) => d.textContent);
    expect(dividers).toHaveLength(3);
    expect(dividers.slice(1)).toEqual(["Yesterday", "Today"]);
    expect(container.querySelectorAll('[data-role="user"] time')).toHaveLength(3);
    expect(container.querySelectorAll('[data-role="assistant"] > time')).toHaveLength(2);
  });

  it("opens a reply's image in the lightbox", () => {
    show("main1", [{ id: "a", role: "assistant", content: [{ type: "image", mimeType: "image/png", data: "QQ" }], timestamp: Date.now() }]);
    fireEvent.click(screen.getByRole("button", { name: "Open image" }));
    expect(screen.getByTestId("lightbox").querySelector("img")!.getAttribute("src")).toBe("data:image/png;base64,QQ");
  });
});
