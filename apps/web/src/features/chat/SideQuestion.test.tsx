/**
 * Side questions in the web app (I-140): the card, the composer's Ask Aside button (visibility,
 * ⌥↩, placeholder), "Tell the Agent" prefilling the composer, the `/btw` built-in, and where cards
 * sit in the transcript.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { createMemoryRouter, RouterProvider } from "react-router";
import { defaultSessionState, defaultSettings, type HarnessCapabilities, type SideQuestionMessage, type Transcript } from "@glade/protocol";
import { TooltipProvider } from "@/ui";
import { models, settings } from "@/state/store";
import { getChatSession, resetChatSessions } from "@/state/chat-session";
import { harnesses } from "@/state/harnesses";
import { Composer } from "./Composer";
import { SideQuestionCard } from "./SideQuestionCard";
import { prefillComposer } from "./composer-prefill";
import { builtinCommands } from "./slash/builtins";
import { groupTranscript } from "./grouping";

vi.mock("@/lib/api", () => ({
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
vi.mock("@/lib/api-folder", () => ({
  listFolderCommands: vi.fn(async () => []),
  searchFiles: vi.fn(async () => ({ entries: [], truncated: false })),
  getHarnessDefaults: vi.fn(async () => ({ model: null, thinkingLevel: null })),
}));
vi.mock("@/lib/socket", () => ({ socket: { send: vi.fn(), watch: vi.fn(() => () => {}) } }));

const { api } = await import("@/lib/api");

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
const slot = () => screen.getByTestId("ask-aside-slot");
const askButton = () => slot().querySelector("button")!;

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

describe("Ask Aside button (I-140)", () => {
  it("keeps its slot but is invisible unless the agent is running and there's text", () => {
    const store = readyChat("c1", false);
    renderComposer();
    // Idle, with text: slot reserved, button hidden and not clickable.
    fireEvent.input(box(), { target: { value: "what now?" } });
    expect(slot().className).toContain("invisible");
    expect(askButton().disabled).toBe(true);
    expect(askButton().tabIndex).toBe(-1);
    expect(box().placeholder).toBe("Ask anything…");
    // Running, empty: still hidden; the placeholder suggests ⌥↩.
    store.state.value = { ...store.state.value, isRunning: true };
    fireEvent.input(box(), { target: { value: "" } });
    expect(slot().className).toContain("invisible");
    expect(box().placeholder).toBe("Queue a message, or ⌥↩ to ask aside");
    // Running with text: shown.
    fireEvent.input(box(), { target: { value: "what now?" } });
    expect(slot().className).not.toContain("invisible");
    expect(askButton().disabled).toBe(false);
  });

  it("asks the text aside on click, clearing the box; restores it when it fails", async () => {
    readyChat("c1", true);
    renderComposer();
    fireEvent.input(box(), { target: { value: " which file? " } });
    fireEvent.click(askButton());
    await waitFor(() => expect(api.askSideQuestion).toHaveBeenCalledWith("c1", "which file?"));
    expect(box().value).toBe("");
    expect(api.prompt).not.toHaveBeenCalled();
    vi.mocked(api.askSideQuestion).mockRejectedValueOnce(new Error("nope"));
    fireEvent.input(box(), { target: { value: "again" } });
    fireEvent.click(askButton());
    await waitFor(() => expect(box().value).toBe("again"));
  });

  it("⌥↩ asks aside only while running with text (a typed /btw prefix is dropped)", async () => {
    const store = readyChat("c1", false);
    renderComposer();
    fireEvent.input(box(), { target: { value: "idle question" } });
    fireEvent.keyDown(box(), { key: "Enter", altKey: true });
    expect(api.askSideQuestion).not.toHaveBeenCalled();
    expect(api.prompt).not.toHaveBeenCalled();
    store.state.value = { ...store.state.value, isRunning: true };
    fireEvent.input(box(), { target: { value: "/btw is it done?" } });
    fireEvent.keyDown(box(), { key: "Enter", altKey: true });
    await waitFor(() => expect(api.askSideQuestion).toHaveBeenCalledWith("c1", "is it done?"));
    expect(api.prompt).not.toHaveBeenCalled();
  });

  it("isn't there for harnesses without side questions", () => {
    setCaps({ sideQuestions: false });
    readyChat("c1", true);
    renderComposer();
    expect(screen.queryByTestId("ask-aside-slot")).toBeNull();
    expect(box().placeholder).toBe("Queue a message…");
  });
});

describe("composer buttons don't pop in and out (I-151)", () => {
  it("keeps Send in place (disabled without text) while running; only Ask Aside appears", () => {
    readyChat("c1", true);
    renderComposer();
    const send = () => screen.getByRole("button", { name: "Queue message" }) as HTMLButtonElement;
    expect(send().disabled).toBe(true);
    expect(slot().className).toContain("invisible");
    fireEvent.input(box(), { target: { value: "hey" } });
    expect(send().disabled).toBe(false);
    expect(slot().className).not.toContain("invisible");
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
