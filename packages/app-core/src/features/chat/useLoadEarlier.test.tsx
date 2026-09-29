/**
 * I-169: a transcript opened with the newest turns loads earlier ones when scrolled near the top,
 * and keeps the reader's place (distance from the bottom) when they're prepended.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { defaultSessionState, type ChatMessage } from "@glade/protocol";
import { TooltipProvider } from "@glade/app-core/ui";
import { sessions } from "@glade/app-core/state/store";
import { getChatSession, resetChatSessions } from "@glade/app-core/state/chat-session";
import { makeSession } from "@glade/app-core/test/fixtures";
import { api } from "@glade/app-core/lib/api";
import { Transcript } from "./Transcript";

vi.mock("@glade/app-core/lib/api", () => ({ api: { getSession: vi.fn(() => new Promise(() => {})), getTranscriptPage: vi.fn() } }));
vi.mock("@glade/app-core/lib/socket", () => ({ socket: { send: vi.fn(), watch: vi.fn(() => () => {}) } }));

Element.prototype.scrollTo = vi.fn() as unknown as Element["scrollTo"];

const messages: ChatMessage[] = Array.from({ length: 40 }, (_, i) => ({
  id: `m${i}`,
  role: "user" as const,
  content: [{ type: "text" as const, text: `question ${i}` }],
  timestamp: 1000 + i,
}));

// jsdom has no layout: every rendered message is 100px tall, the viewport 300px.
const descriptors = {
  scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight"),
  clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight"),
};
beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get(this: Element) {
      return this.querySelectorAll("[data-role]").length * 100;
    },
  });
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => 300 });
  resetChatSessions();
  sessions.value = [makeSession({ id: "c1", workspaceId: "w1" })];
  vi.mocked(api.getTranscriptPage).mockReset();
});
afterEach(() => {
  for (const [key, d] of Object.entries(descriptors)) if (d) Object.defineProperty(Element.prototype, key, d);
});

function setup() {
  const store = getChatSession("c1");
  store.status.value = "ready";
  store.state.value = defaultSessionState();
  store.transcript.value = { messages: messages.slice(30), toolResults: {} };
  store.start.value = 30;
  render(
    <TooltipProvider>
      <Transcript chatId="c1" />
    </TooltipProvider>,
  );
  return { store, scroller: screen.getByTestId("transcript-scroll") };
}

describe("Transcript: load earlier on scroll (I-169)", () => {
  it("loads the turns before the first one near the top and keeps the reading position", async () => {
    vi.mocked(api.getTranscriptPage).mockResolvedValueOnce({ messages: messages.slice(20, 30), toolResults: {}, start: 20, total: 40 });
    const { store, scroller } = setup();
    expect(screen.getByRole("button", { name: "Load earlier messages" })).toBeTruthy();
    // 10 messages (1000px); the reader scrolled up to 200px from the top (800px from the bottom).
    scroller.scrollTop = 200;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(store.start.value).toBe(20));
    expect(api.getTranscriptPage).toHaveBeenCalledWith("c1", 30, 50);
    await screen.findByText("question 20");
    // 20 messages now (2000px): still 800px from the bottom, on the same message.
    expect(scroller.scrollTop).toBe(1200);
  });

  it("doesn't load while far from the top, or when everything is loaded", async () => {
    const { store, scroller } = setup();
    scroller.scrollTop = 700;
    fireEvent.scroll(scroller);
    store.start.value = 0;
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    expect(api.getTranscriptPage).not.toHaveBeenCalled();
  });
});
