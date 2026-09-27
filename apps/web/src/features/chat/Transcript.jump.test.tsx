import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/preact";
import { defaultSessionState, type ChatMessage } from "@glade/protocol";
import { TooltipProvider } from "@/ui";
import { sessions } from "@/state/store";
import { getChatSession, resetChatSessions } from "@/state/chat-session";
import { toasts } from "@/state/toasts";
import { makeSession } from "@/test/fixtures";
import { pendingJump, requestJump } from "./jump-to-message";
import { Transcript } from "./Transcript";

vi.mock("@/lib/api", () => ({ api: { getSession: vi.fn(() => new Promise(() => {})) } }));
vi.mock("@/lib/socket", () => ({ socket: { send: vi.fn(), watch: vi.fn(() => () => {}) } }));

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

  it("stays at the bottom and says so when the message isn't loaded", async () => {
    requestJump("c1", { role: "user", timestamp: 42 });
    setup();
    await waitFor(() => expect(toasts.value.map((t) => t.message)).toEqual(["Message not in loaded history"]));
    expect(document.querySelector(".pi-jump-highlight")).toBeNull();
  });

  it("ignores requests for another chat", async () => {
    requestJump("other", { role: "user", timestamp: 1000 });
    setup();
    await screen.findByText("question 0");
    expect(pendingJump.value).not.toBeNull();
    expect(document.querySelector(".pi-jump-highlight")).toBeNull();
  });
});
