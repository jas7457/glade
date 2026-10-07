/**
 * Side questions in the web app (I-140): the card, Ask Aside on the composer's Send button (⌥ held,
 * ⌥↩, placeholder; I-200), "Tell the Agent" prefilling the composer, the `/btw` built-in, and where cards
 * sit in the transcript.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { createMemoryRouter, RouterProvider } from "react-router";
import { defaultSessionState, defaultSettings, type HarnessCapabilities, type SideQuestionMessage, type Transcript } from "@glade/protocol";
import { TooltipProvider } from "@glade/app-core/ui";
import { models, settings } from "@glade/app-core/state/store";
import { getChatSession, resetChatSessions } from "@glade/app-core/state/chat-session";
import { harnesses } from "@glade/app-core/state/harnesses";
import { Composer } from "./Composer";
import { SideQuestionCard } from "./SideQuestionCard";
import { prefillComposer } from "./composer-prefill";
import { builtinCommands } from "./slash/builtins";
import { groupTranscript } from "./grouping";
import { MODIFIER_SHOW_DELAY_MS } from "./use-held-modifiers";

vi.mock("@glade/app-core/lib/api", () => ({
  api: {
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    getSession: vi.fn(() => new Promise(() => {})),
    listCommands: vi.fn(async () => []),
    askSideQuestion: vi.fn(async () => ({ id: "side-1" })),
    stopSideQuestion: vi.fn(async () => undefined),
    dismissSideQuestion: vi.fn(async () => undefined),
  },
}));
vi.mock("@glade/app-core/lib/api-folder", () => ({
  listFolderCommands: vi.fn(async () => []),
  searchFiles: vi.fn(async () => ({ entries: [], truncated: false })),
  getHarnessDefaults: vi.fn(async () => ({ model: null, thinkingLevel: null })),
}));
vi.mock("@glade/app-core/lib/socket", () => ({ socket: { send: vi.fn(), watch: vi.fn(() => () => {}) } }));

const { api } = await import("@glade/app-core/lib/api");

const CAPS: HarnessCapabilities = { compact: true, exportHtml: true, steering: true, uiRequests: true, usageLimits: true, commands: true, subagents: true, shell: true, sideQuestions: true };

function setCaps(caps: Partial<HarnessCapabilities>) {
  harnesses.value = [{ id: "pi", label: "pi", isDefault: true, capabilities: { ...CAPS, ...caps } }];
}

function readyChat(chatId: string, running: boolean) {
  const store = getChatSession(chatId);
  store.status.value = "ready";
  store.state.value = { ...defaultSessionState(), isRunning: running };
  return store;
}

function renderComposer(chatId = "c1") {
  const router = createMemoryRouter([{ path: "/", element: <TooltipProvider><Composer chatId={chatId} /></TooltipProvider> }], { initialEntries: ["/"] });
  render(<RouterProvider router={router} />);
}

const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const sendButton = () => screen.getByRole("button", { name: /^(Send|Steer|Send follow-up|Queue message|Ask Aside)$/ }) as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  resetChatSessions();
  settings.value = defaultSettings();
  models.value = [];
  setCaps({});
});
afterEach(() => {
  harnesses.value = null;
});

describe("Ask Aside on the Send button (I-140, I-200)", () => {
  /** Hold ⌥ past the no-flicker delay. */
  const holdAlt = async () => {
    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    await new Promise((r) => setTimeout(r, MODIFIER_SHOW_DELAY_MS + 60));
  };
  const releaseAlt = () => fireEvent.keyUp(window, { key: "Alt", altKey: false });

  it("no separate button; Send becomes Ask Aside while ⌥ is held, only while running", async () => {
    const store = readyChat("c1", false);
    renderComposer();
    expect(screen.queryByRole("button", { name: /ask aside/i })).toBeNull();
    // Idle, with text: ⌥ changes nothing.
    fireEvent.input(box(), { target: { value: "what now?" } });
    await holdAlt();
    expect(sendButton().getAttribute("aria-label")).toBe("Send");
    releaseAlt();
    expect(box().placeholder).toBe("Ask anything…");
    // Running, empty: the placeholder names the keys, ⌥↩ included (I-153); ⌥ shows Ask Aside, disabled.
    store.state.value = { ...store.state.value, isRunning: true };
    fireEvent.input(box(), { target: { value: "" } });
    expect(box().placeholder).toBe("↩ steer · ⌘↩ follow-up · ⌥↩ ask aside");
    await holdAlt();
    expect(sendButton().getAttribute("aria-label")).toBe("Ask Aside");
    expect(sendButton().disabled).toBe(true);
    // Running with text: enabled.
    fireEvent.input(box(), { target: { value: "what now?" } });
    expect(sendButton().disabled).toBe(false);
    releaseAlt();
    expect(sendButton().getAttribute("aria-label")).toBe("Steer");
  });

  it("asks the text aside on ⌥-click, clearing the box; restores it when it fails", async () => {
    readyChat("c1", true);
    renderComposer();
    fireEvent.input(box(), { target: { value: " which file? " } });
    fireEvent.click(sendButton(), { altKey: true });
    await waitFor(() => expect(api.askSideQuestion).toHaveBeenCalledWith("c1", "which file?"));
    expect(box().value).toBe("");
    expect(api.prompt).not.toHaveBeenCalled();
    vi.mocked(api.askSideQuestion).mockRejectedValueOnce(new Error("nope"));
    fireEvent.input(box(), { target: { value: "again" } });
    fireEvent.click(sendButton(), { altKey: true });
    await waitFor(() => expect(box().value).toBe("again"));
  });

  it("⌥↩ asks aside only while running (idle it sends; a typed /btw prefix is dropped)", async () => {
    const store = readyChat("c1", false);
    renderComposer();
    fireEvent.input(box(), { target: { value: "idle question" } });
    fireEvent.keyDown(box(), { key: "Enter", altKey: true });
    await waitFor(() => expect(api.prompt).toHaveBeenCalledWith("c1", { text: "idle question", images: undefined, behavior: undefined }));
    expect(api.askSideQuestion).not.toHaveBeenCalled();
    store.state.value = { ...store.state.value, isRunning: true };
    fireEvent.input(box(), { target: { value: "/btw is it done?" } });
    fireEvent.keyDown(box(), { key: "Enter", altKey: true });
    await waitFor(() => expect(api.askSideQuestion).toHaveBeenCalledWith("c1", "is it done?"));
    expect(api.prompt).toHaveBeenCalledTimes(1);
  });

  it("⌥ does nothing for harnesses without side questions", async () => {
    setCaps({ sideQuestions: false });
    readyChat("c1", true);
    renderComposer();
    expect(box().placeholder).toBe("↩ steer · ⌘↩ follow-up");
    fireEvent.input(box(), { target: { value: "hm" } });
    await holdAlt();
    expect(sendButton().getAttribute("aria-label")).toBe("Steer");
    releaseAlt();
  });

  it("without steering, the placeholder says messages are queued; ⌥↩ still asks aside (I-153)", async () => {
    setCaps({ steering: false });
    readyChat("c1", true);
    renderComposer();
    expect(box().placeholder).toBe("Queue a message, or ⌥↩ to ask aside");
    fireEvent.input(box(), { target: { value: "quick one" } });
    fireEvent.keyDown(box(), { key: "Enter", altKey: true });
    await waitFor(() => expect(api.askSideQuestion).toHaveBeenCalledWith("c1", "quick one"));
    expect(api.prompt).not.toHaveBeenCalled();
  });
});

describe("composer buttons don't pop in and out (I-151)", () => {
  it("keeps Send in place (disabled without text) while running; held keys swap it in place", async () => {
    readyChat("c1", true);
    renderComposer();
    expect(sendButton().getAttribute("aria-label")).toBe("Steer");
    expect(sendButton().disabled).toBe(true);
    fireEvent.input(box(), { target: { value: "hey" } });
    expect(sendButton().disabled).toBe(false);
    // Holding ⌘ / ⌥ swaps the send button in place (I-153, I-200).
    const before = sendButton();
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send follow-up" })).toBe(before));
    fireEvent.keyUp(window, { key: "Meta", metaKey: false });
    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask Aside" })).toBe(before));
    fireEvent.keyUp(window, { key: "Alt", altKey: false });
    expect(sendButton()).toBe(before);
  });
});

describe("/btw (I-140)", () => {
  it("asks a side question, also while running; needs a question", async () => {
    readyChat("c1", true);
    renderComposer();
    fireEvent.input(box(), { target: { value: "/btw   " } });
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(box().value).toBe("/btw   ")); // kept for editing
    expect(api.askSideQuestion).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 10));
    fireEvent.input(box(), { target: { value: "/btw why that approach?" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(api.askSideQuestion).toHaveBeenCalledWith("c1", "why that approach?"));
    expect(api.prompt).not.toHaveBeenCalled();
    await waitFor(() => expect(box().value).toBe(""));
  });

  it("is offered only when the harness has side questions", () => {
    expect(builtinCommands(true, CAPS).some((c) => c.name === "btw")).toBe(true);
    const { sideQuestions: _omit, ...without } = CAPS;
    expect(builtinCommands(true, without).some((c) => c.name === "btw")).toBe(false);
    expect(builtinCommands(true, { ...CAPS, sideQuestions: false }).some((c) => c.name === "btw")).toBe(false);
    expect(builtinCommands(false).some((c) => c.name === "btw")).toBe(false); // needs a chat
  });
});

const card = (over: Partial<SideQuestionMessage> = {}): SideQuestionMessage => ({
  id: "side-1",
  role: "side",
  question: "Which file holds the parser?",
  answer: "It's in `src/parser.ts`.",
  status: "done",
  model: "anthropic/claude-haiku-4-5",
  timestamp: 1,
  ...over,
});

function renderCard(message: SideQuestionMessage) {
  return render(
    <TooltipProvider>
      <SideQuestionCard message={message} chatId="c1" />
    </TooltipProvider>,
  );
}

describe("SideQuestionCard (I-140)", () => {
  it("while streaming: the question, the answer so far and Stop; no hand-off buttons yet", () => {
    readyChat("c1", true);
    renderCard(card({ status: "streaming", answer: "" }));
    expect(screen.getByText("Side question")).toBeTruthy();
    expect(screen.getByText("Which file holds the parser?")).toBeTruthy();
    expect(screen.getByText("Thinking about it…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tell the Agent" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(api.stopSideQuestion).toHaveBeenCalledWith("c1", "side-1");
  });

  it("when answered: Tell the Agent, Add to Queue (a follow-up while running) and Dismiss", async () => {
    readyChat("c1", true);
    const { container } = renderCard(card());
    expect(container.textContent).toContain("src/parser.ts");
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add to Queue" }));
    await waitFor(() =>
      expect(api.prompt).toHaveBeenCalledWith("c1", {
        text: 'About my side question "Which file holds the parser?":\n\nIt\'s in `src/parser.ts`.',
        behavior: "followUp",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(api.dismissSideQuestion).toHaveBeenCalledWith("c1", "side-1");
  });

  it("sends Add to Queue right away when the agent is idle", async () => {
    readyChat("c1", false);
    renderCard(card());
    fireEvent.click(screen.getByRole("button", { name: "Add to Queue" }));
    await waitFor(() => expect(api.prompt).toHaveBeenCalledWith("c1", { text: expect.stringContaining("src/parser.ts") }));
  });

  it("shows failures and stops; only Dismiss when there's no answer", () => {
    readyChat("c1", false);
    renderCard(card({ status: "error", answer: "", error: "429 rate limited" }));
    expect(screen.getByRole("alert").textContent).toBe("429 rate limited");
    expect(screen.queryByRole("button", { name: "Tell the Agent" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });
});

describe("side question threads (I-156)", () => {
  const reply = () => screen.getByRole("textbox", { name: "Reply to the side question" }) as HTMLInputElement;

  it("Reply asks a follow-up in the same card (↩ sends); restores the text when it fails", async () => {
    readyChat("c1", true);
    renderCard(card());
    fireEvent.input(reply(), { target: { value: " and the lexer? " } });
    fireEvent.keyDown(reply(), { key: "Enter" });
    await waitFor(() => expect(api.askSideQuestion).toHaveBeenCalledWith("c1", "and the lexer?", "side-1"));
    expect(reply().value).toBe("");
    expect(api.prompt).not.toHaveBeenCalled();
    vi.mocked(api.askSideQuestion).mockRejectedValueOnce(new Error("nope"));
    fireEvent.input(reply(), { target: { value: "again" } });
    fireEvent.click(screen.getByRole("button", { name: "Send follow-up (↩)" }));
    await waitFor(() => expect(reply().value).toBe("again"));
  });

  it("shows the thread in order; while a follow-up streams: Stop stops it, Reply can't send, no hand-offs", () => {
    readyChat("c1", true);
    const { container } = renderCard(
      card({ followUps: [{ id: "side-2", question: "And the lexer?", answer: "", status: "streaming", timestamp: 2, model: "p/fast" }] }),
    );
    expect([...container.querySelectorAll("[data-turn]")].map((e) => e.getAttribute("data-turn"))).toEqual(["side-1", "side-2"]);
    expect(container.textContent).toContain("src/parser.ts");
    expect(screen.getByText("And the lexer?")).toBeTruthy();
    expect(screen.getByText("Thinking about it…")).toBeTruthy();
    expect(screen.getByText("p/fast")).toBeTruthy();
    fireEvent.input(reply(), { target: { value: "next one" } });
    fireEvent.keyDown(reply(), { key: "Enter" });
    expect(api.askSideQuestion).not.toHaveBeenCalled();
    expect(reply().value).toBe("next one");
    expect((screen.getByRole("button", { name: "Send follow-up (↩)" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Tell the Agent" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(api.stopSideQuestion).toHaveBeenCalledWith("c1", "side-2");
    expect(api.stopSideQuestion).toHaveBeenCalledTimes(1);
  });

  it("Add to Queue passes on the whole thread; a cut context is labelled", async () => {
    readyChat("c1", false);
    renderCard(card({ partialContext: true, followUps: [{ id: "side-2", question: "And the lexer?", answer: "`src/lexer.ts`.", status: "done", timestamp: 2 }] }));
    expect(screen.getAllByText("(only saw part of the chat)")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Add to Queue" }));
    await waitFor(() =>
      expect(api.prompt).toHaveBeenCalledWith("c1", {
        text: "About my side questions:\n\n**Q:** Which file holds the parser?\n\nIt's in `src/parser.ts`.\n\n**Q:** And the lexer?\n\n`src/lexer.ts`.",
      }),
    );
  });
});

describe("Tell the Agent prefills the composer (I-140)", () => {
  it("adds the note after what's typed and focuses the box", async () => {
    readyChat("c1", true);
    renderComposer();
    fireEvent.input(box(), { target: { value: "Also:" } });
    prefillComposer("c1", "About my side question \"q\":\n\na");
    await waitFor(() => expect(box().value).toBe('Also:\n\nAbout my side question "q":\n\na'));
    expect(document.activeElement).toBe(box());
    expect(api.prompt).not.toHaveBeenCalled();
  });

  it("ignores requests for another chat", async () => {
    readyChat("c3", true);
    renderComposer("c3");
    prefillComposer("c2", "elsewhere");
    await new Promise((r) => setTimeout(r, 10));
    expect(box().value).toBe("");
  });
});

describe("side cards in the transcript (I-140)", () => {
  const user = (id: string) => ({ id, role: "user" as const, content: [{ type: "text" as const, text: id }], timestamp: 1 });
  const reply = (id: string) => ({ id, role: "assistant" as const, content: [{ type: "text" as const, text: id }], timestamp: 2 });

  it("don't split the turn they were asked in (shown after it); dismissed ones are hidden", () => {
    const t: Transcript = {
      messages: [user("u1"), reply("a1"), card({ id: "s1" }), reply("a2"), card({ id: "s2", dismissed: true }), user("u2"), card({ id: "s3" })],
      toolResults: {},
    };
    const items = groupTranscript(t, { isRunning: false });
    expect(items.map((i) => `${i.type}:${i.key}`)).toEqual(["user:u1", "turn:turn-a1", "side:s1", "user:u2", "side:s3"]);
  });
});
