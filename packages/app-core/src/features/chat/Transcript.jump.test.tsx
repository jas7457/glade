import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/preact";
import { defaultSessionState, type ChatMessage } from "@glade/protocol";
import { TooltipProvider } from "@glade/app-core/ui";
import { sessions } from "@glade/app-core/state/store";
import { getChatSession, resetChatSessions } from "@glade/app-core/state/chat-session";
import { toasts } from "@glade/app-core/state/toasts";
import { makeSession } from "@glade/app-core/test/fixtures";
import { JUMP_MARGIN, pendingJump, requestJump } from "./jump-to-message";
import { Transcript } from "./Transcript";
import { api } from "@glade/app-core/lib/api";

vi.mock("@glade/app-core/lib/api", () => ({ api: { getSession: vi.fn(() => new Promise(() => {})), getTranscriptPage: vi.fn() } }));
vi.mock("@glade/app-core/lib/socket", () => ({ socket: { send: vi.fn(), watch: vi.fn(() => () => {}) } }));

const scrollTo = vi.fn();
Element.prototype.scrollTo = scrollTo as unknown as Element["scrollTo"];

const messages: ChatMessage[] = Array.from({ length: 6 }, (_, i) =>
  i % 2 === 0
    ? { id: `h${i}`, role: "user" as const, content: [{ type: "text" as const, text: `question ${i}` }], timestamp: 1000 + i }
    : { id: `h${i}`, role: "assistant" as const, content: [{ type: "text" as const, text: `answer ${i}` }], timestamp: 1000 + i },
);

function setup() {
  const store = getChatSession("c1");
  store.status.value = "ready";
  store.state.value = defaultSessionState();
  store.transcript.value = { messages, toolResults: {} };
  render(
    <TooltipProvider>
      <Transcript chatId="c1" />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  scrollTo.mockClear();
  resetChatSessions();
  toasts.value = [];
  pendingJump.value = null;
  sessions.value = [makeSession({ id: "c1", workspaceId: "w1" })];
});

describe("Transcript: jump to a search hit (I-093)", () => {
  it("scrolls to and highlights the requested message instead of staying at the bottom", async () => {
    requestJump("c1", { role: "assistant", timestamp: 1003 });
    setup();
    const answer = await screen.findByText("answer 3");
    await waitFor(() => expect(answer.closest(".pi-jump-highlight")).toBeTruthy());
    expect(screen.getByText("answer 1").closest(".pi-jump-highlight")).toBeNull();
    expect(document.querySelectorAll(".pi-jump-highlight")).toHaveLength(1);
    expect(pendingJump.value).toBeNull();
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "auto" }));
    expect(toasts.value).toEqual([]);
  });

  describe("position (I-206)", () => {
    afterEach(() => vi.restoreAllMocks());

    /** A 600px viewport over 5000px of content; the "answer 3" text starts 1000px down. */
    function fakeLayout(answerTop: number) {
      const isScroll = (el: Element) => (el as HTMLElement).dataset?.testid === "transcript-scroll";
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
        return isScroll(this) ? 600 : 0;
      });
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
        return isScroll(this) ? 5000 : 0;
      });
      // Scrolled to the top (the scroll container's own position: 0).
      vi.spyOn(Element.prototype, "scrollTop", "get").mockReturnValue(0);
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        const top = this.textContent === "answer 3" && this.classList.contains("pi-md") ? answerTop : 0;
        return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
      });
    }

    it("puts the message's start near the top with a margin, not centered", async () => {
      fakeLayout(1000);
      requestJump("c1", { role: "assistant", timestamp: 1003 });
      setup();
      const answer = await screen.findByText("answer 3");
      await waitFor(() => expect(answer.closest(".pi-jump-highlight")).toBeTruthy());
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 1000 - JUMP_MARGIN, behavior: "auto" });
    });

    it("stops at the end of the transcript", async () => {
      fakeLayout(4900);
      requestJump("c1", { role: "assistant", timestamp: 1003 });
      setup();
      const answer = await screen.findByText("answer 3");
      await waitFor(() => expect(answer.closest(".pi-jump-highlight")).toBeTruthy());
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 4400, behavior: "auto" });
    });
  });

  it("stays at the bottom and says so when the message isn't loaded", async () => {
    requestJump("c1", { role: "user", timestamp: 42 });
    setup();
    await waitFor(() => expect(toasts.value.map((t) => t.message)).toEqual(["Message not in loaded history"]));
    expect(document.querySelector(".pi-jump-highlight")).toBeNull();
  });

  it("loads earlier turns when the message is before the loaded ones (I-169)", async () => {
    vi.mocked(api.getTranscriptPage).mockResolvedValueOnce({ messages: messages.slice(0, 4), toolResults: {}, start: 0, total: 6 });
    const store = getChatSession("c1");
    store.status.value = "ready";
    store.transcript.value = { messages: messages.slice(4), toolResults: {} };
    store.start.value = 4;
    requestJump("c1", { role: "assistant", timestamp: 1003 });
    render(
      <TooltipProvider>
        <Transcript chatId="c1" />
      </TooltipProvider>,
    );
    const answer = await screen.findByText("answer 3");
    await waitFor(() => expect(answer.closest(".pi-jump-highlight")).toBeTruthy());
    expect(api.getTranscriptPage).toHaveBeenCalledWith("c1", 4, 200);
    expect(toasts.value).toEqual([]);
  });

  it("ignores requests for another chat", async () => {
    requestJump("other", { role: "user", timestamp: 1000 });
    setup();
    await screen.findByText("question 0");
    expect(pendingJump.value).not.toBeNull();
    expect(document.querySelector(".pi-jump-highlight")).toBeNull();
  });
});
