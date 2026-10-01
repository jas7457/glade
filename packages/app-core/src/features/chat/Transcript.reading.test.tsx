import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/preact";
import { defaultSessionState, type ChatMessage } from "@glade/protocol";
import { TooltipProvider } from "@glade/app-core/ui";
import { sessions } from "@glade/app-core/state/store";
import { getChatSession, resetChatSessions } from "@glade/app-core/state/chat-session";
import { readingHighlight } from "@glade/app-core/state/reading-highlight";
import { makeSession } from "@glade/app-core/test/fixtures";
import { Transcript } from "./Transcript";

vi.mock("@glade/app-core/lib/api", () => ({ api: { getSession: vi.fn(() => new Promise(() => {})) } }));
vi.mock("@glade/app-core/lib/socket", () => ({ socket: { send: vi.fn(), watch: vi.fn(() => () => {}) } }));
Element.prototype.scrollTo = vi.fn() as unknown as Element["scrollTo"];

const reply = (id: string, texts: string[]): ChatMessage => ({ id, role: "assistant", content: texts.map((text) => ({ type: "text" as const, text })), timestamp: Date.now() });

beforeEach(() => {
  resetChatSessions();
  readingHighlight.value = null;
  sessions.value = [makeSession({ id: "c1", workspaceId: "w1" })];
});

describe("Transcript: the word being read aloud (I-193)", () => {
  it("highlights the range in the right message's block, and nothing once reading stops", async () => {
    const store = getChatSession("c1");
    store.status.value = "ready";
    store.state.value = defaultSessionState();
    store.transcript.value = {
      messages: [
        { id: "u", role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() },
        reply("a1", ["First reply with words.", "A **second** block here."]),
        reply("a2", ["Second reply with words."]),
      ],
      toolResults: {},
    };
    const { container } = render(
      <TooltipProvider>
        <Transcript chatId="c1" />
      </TooltipProvider>,
    );
    const marks = () => [...container.querySelectorAll("mark[data-reading]")].map((m) => m.textContent);
    act(() => void (readingHighlight.value = { messageId: "a1", block: 1, range: [4, 10] }));
    await waitFor(() => expect(marks()).toEqual(["second"]));
    act(() => void (readingHighlight.value = { messageId: "a2", block: 0, range: [7, 12] }));
    await waitFor(() => expect(marks()).toEqual(["reply"]));
    expect(container.querySelector("mark[data-reading]")!.closest("p")!.textContent).toBe("Second reply with words.");
    act(() => void (readingHighlight.value = null));
    await waitFor(() => expect(marks()).toEqual([]));
  });
});
