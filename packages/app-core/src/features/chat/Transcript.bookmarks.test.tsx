/**
 * I-203: bookmarks in the transcript: the hover toggle on user messages and agent replies, the
 * ribbon on bookmarked ones, the scroll-edge ticks (click → scroll + flash) and the right-click
 * menu (Bookmark Reply / Remove Bookmark / Copy).
 *
 * I-206: a reply's ribbon sits where its text starts (not beside a leading thought / tool calls),
 * and clicking a ribbon removes the bookmark (a menu when the message has several).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { defaultSessionState, type Bookmark, type ChatMessage, type ContentBlock, type Transcript as TranscriptData } from "@glade/protocol";
import { TooltipProvider } from "@glade/app-core/ui";
import { bookmarks, sessions } from "@glade/app-core/state/store";
import { getChatSession, resetChatSessions } from "@glade/app-core/state/chat-session";
import { makeSession } from "@glade/app-core/test/fixtures";
import { Transcript } from "./Transcript";
import { OptionSheetContext, type OptionSheetProps } from "./option-sheet";
import { api } from "@glade/app-core/lib/api";

vi.mock("@glade/app-core/lib/api", () => ({
  api: {
    getSession: vi.fn(() => new Promise(() => {})),
    getTranscriptPage: vi.fn(),
    createBookmark: vi.fn(),
    deleteBookmark: vi.fn(async () => undefined),
  },
}));
vi.mock("@glade/app-core/lib/socket", () => ({ socket: { send: vi.fn(), watch: vi.fn(() => () => {}) } }));

const scrollTo = vi.fn();
Element.prototype.scrollTo = scrollTo as unknown as Element["scrollTo"];

const messages: ChatMessage[] = [
  { id: "u1", role: "user", content: [{ type: "text", text: "what are the numbers?" }], timestamp: 1000 },
  { id: "a1", role: "assistant", content: [{ type: "text", text: "## Q3\n\nRevenue is up." }], timestamp: 1001 },
  { id: "u2", role: "user", content: [{ type: "text", text: "thanks" }], timestamp: 1002 },
  { id: "a2", role: "assistant", content: [{ type: "text", text: "You're welcome." }], timestamp: 1003 },
];

const bm = (over: Partial<Bookmark> & { id: string }): Bookmark => ({
  sessionId: "c1",
  workspaceId: "w1",
  message: { role: "assistant", timestamp: 1001 },
  label: "Q3",
  labelSource: "auto",
  excerpt: "Q3 Revenue is up.",
  createdAt: 1,
  ...over,
});

/** A bare sheet (the iPhone provides a real one): its items as buttons. */
function FakeSheet({ open, title, sections }: OptionSheetProps) {
  if (!open) return null;
  return (
    <div role="dialog" aria-label={title}>
      {sections.flatMap((s) => s.items).map((i) => (
        <button key={i.key} type="button" onClick={i.onSelect}>
          {i.label}
        </button>
      ))}
    </div>
  );
}

function setup(msgs: ChatMessage[] = messages, toolResults: TranscriptData["toolResults"] = {}, sheet = false) {
  const store = getChatSession("c1");
  store.status.value = "ready";
  store.state.value = defaultSessionState();
  store.transcript.value = { messages: msgs, toolResults };
  const transcript = <Transcript chatId="c1" />;
  render(<TooltipProvider>{sheet ? <OptionSheetContext.Provider value={FakeSheet}>{transcript}</OptionSheetContext.Provider> : transcript}</TooltipProvider>);
}

const reply = (text: string) => screen.getByText(text).closest("[data-role]") as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  scrollTo.mockClear();
  resetChatSessions();
  bookmarks.value = [];
  sessions.value = [makeSession({ id: "c1", workspaceId: "w1" })];
});

describe("Transcript bookmarks (I-203)", () => {
  it("the hover toggle bookmarks a reply (anchored by its first message, with its text) and a user message", async () => {
    vi.mocked(api.createBookmark).mockImplementation(async (body) => bm({ id: `b${body.message.timestamp}`, message: body.message }));
    setup();
    const answer = reply("Revenue is up.");
    fireEvent.click(within(answer).getByRole("button", { name: "Bookmark" }));
    await waitFor(() => expect(api.createBookmark).toHaveBeenCalledWith({ sessionId: "c1", message: { role: "assistant", timestamp: 1001 }, text: "## Q3\n\nRevenue is up." }));
    // Now pressed, with a ribbon.
    await waitFor(() => expect(within(answer).getByRole("button", { name: "Remove Bookmark" }).getAttribute("aria-pressed")).toBe("true"));
    expect(within(answer).getByTestId("bookmark-ribbon")).toBeTruthy();

    const question = reply("thanks");
    fireEvent.click(within(question).getByRole("button", { name: "Bookmark" }));
    await waitFor(() => expect(api.createBookmark).toHaveBeenLastCalledWith({ sessionId: "c1", message: { role: "user", timestamp: 1002 }, text: "thanks" }));
  });

  it("shows ribbons and scroll ticks for this session's bookmarks; a tick scrolls to its message and flashes it", async () => {
    bookmarks.value = [bm({ id: "b1" }), bm({ id: "other", sessionId: "c2", message: { role: "user", timestamp: 1000 } })];
    setup();
    expect(within(reply("Revenue is up.")).getByTestId("bookmark-ribbon").getAttribute("aria-label")).toBe("Remove Bookmark: Q3");
    expect(within(reply("what are the numbers?")).queryByTestId("bookmark-ribbon")).toBeNull();
    const tick = await screen.findByRole("button", { name: "Jump to bookmark: Q3" });
    expect(within(screen.getByTestId("bookmark-ticks")).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(tick);
    expect(screen.getByText("Revenue is up.").closest(".pi-jump-highlight")).toBeTruthy();
    expect(scrollTo).toHaveBeenCalled();
  });

  it("a bookmark whose message isn't loaded gets no tick", () => {
    bookmarks.value = [bm({ id: "gone", message: { role: "assistant", timestamp: 5 } })];
    setup();
    expect(screen.queryByTestId("bookmark-ticks")).toBeNull();
  });

  it("right-click on a reply offers Bookmark Reply / Remove Bookmark; links keep the system menu", async () => {
    vi.mocked(api.createBookmark).mockResolvedValue(bm({ id: "b1" }));
    setup();
    fireEvent.contextMenu(screen.getByText("Revenue is up."));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Bookmark Reply" }));
    await waitFor(() => expect(api.createBookmark).toHaveBeenCalledWith({ sessionId: "c1", message: { role: "assistant", timestamp: 1001 }, text: "## Q3\n\nRevenue is up." }));
    await waitFor(() => expect(bookmarks.value).toHaveLength(1));
    fireEvent.contextMenu(screen.getByText("Revenue is up."));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove Bookmark" }));
    await waitFor(() => expect(api.deleteBookmark).toHaveBeenCalledWith("b1"));
    expect(bookmarks.value).toEqual([]);
  });

  describe("ribbon placement and removal (I-206)", () => {
    const call = (id: string): ContentBlock => ({ type: "toolCall", id, name: "Bash", kind: "shell", input: { command: "ls" }, args: { command: "ls" } });
    const done = (id: string) => ({ toolCallId: id, toolName: "Bash", status: "done" as const, output: "" });
    // A reply that starts with a thought and tool calls; its text comes in a later message.
    const thinkingFirst: ChatMessage[] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "what are the numbers?" }], timestamp: 1000 },
      { id: "a1", role: "assistant", content: [{ type: "thinking", text: "Let me look at the sheet.", redacted: false }, call("t1")], timestamp: 1001 },
      { id: "a2", role: "assistant", content: [call("t2"), { type: "text", text: "Revenue is up." }], timestamp: 1002 },
    ];
    const results = { t1: done("t1"), t2: done("t2") };

    /** The element right after the reply's ribbon slot. */
    const afterRibbon = () => screen.getByTestId("bookmark-ribbon").closest("[data-aux=ribbon].h-0")?.nextElementSibling ?? null;

    it("sits beside the reply's text, not its leading thought / tool calls; a jump lands there too", async () => {
      bookmarks.value = [bm({ id: "b1" })];
      setup(thinkingFirst, results);
      const text = screen.getByText("Revenue is up.");
      const next = afterRibbon();
      expect(next).toBeTruthy();
      expect(next!.contains(text)).toBe(true);
      // The turn still starts with the thought, before the ribbon.
      const turn = reply("Revenue is up.");
      expect(turn.firstElementChild!.textContent).toMatch(/Thought|Thinking/);
      fireEvent.click(await screen.findByRole("button", { name: "Jump to bookmark: Q3" }));
      expect(text.closest(".pi-jump-highlight")).toBe(next);
    });

    it("sits at the top of a reply that starts with text", () => {
      bookmarks.value = [bm({ id: "b1" })];
      setup();
      const turn = reply("Revenue is up.");
      const slot = screen.getByTestId("bookmark-ribbon").closest("[data-aux=ribbon].h-0")!;
      expect(turn.firstElementChild).toBe(slot);
      expect(afterRibbon()!.contains(screen.getByText("Revenue is up."))).toBe(true);
    });

    it("falls back to the top of a reply without text", () => {
      bookmarks.value = [bm({ id: "b1" })];
      setup([thinkingFirst[0]!, thinkingFirst[1]!], { t1: done("t1") });
      const turn = screen.getByTestId("bookmark-ribbon").closest("[data-role]")!;
      expect(turn.getAttribute("data-role")).toBe("assistant");
      expect(turn.firstElementChild).toBe(screen.getByTestId("bookmark-ribbon").closest("[data-aux=ribbon].h-0"));
    });

    it("clicking a reply's ribbon removes its bookmark (and its scroll tick)", async () => {
      bookmarks.value = [bm({ id: "b1" })];
      setup(thinkingFirst, results);
      await screen.findByTestId("bookmark-ticks");
      fireEvent.click(screen.getByRole("button", { name: "Remove Bookmark: Q3" }));
      await waitFor(() => expect(api.deleteBookmark).toHaveBeenCalledWith("b1"));
      expect(bookmarks.value).toEqual([]);
      await waitFor(() => expect(screen.queryByTestId("bookmark-ribbon")).toBeNull());
      expect(screen.queryByTestId("bookmark-ticks")).toBeNull();
    });

    it("clicking a user message's ribbon removes its bookmark", async () => {
      bookmarks.value = [bm({ id: "bu", message: { role: "user", timestamp: 1002 }, label: "thanks" })];
      setup();
      const ribbon = within(reply("thanks")).getByRole("button", { name: "Remove Bookmark: thanks" });
      fireEvent.click(ribbon);
      await waitFor(() => expect(api.deleteBookmark).toHaveBeenCalledWith("bu"));
      expect(bookmarks.value).toEqual([]);
    });

    describe("on the iPhone", () => {
      beforeEach(() => void ((window as { __GLADE_IPHONE__?: boolean }).__GLADE_IPHONE__ = true));
      afterEach(() => void delete (window as { __GLADE_IPHONE__?: boolean }).__GLADE_IPHONE__);

      it("a tap on the ribbon removes the bookmark", async () => {
        bookmarks.value = [bm({ id: "b1" })];
        setup(messages, {}, true);
        fireEvent.click(screen.getByRole("button", { name: "Remove Bookmark: Q3" }));
        await waitFor(() => expect(api.deleteBookmark).toHaveBeenCalledWith("b1"));
        expect(bookmarks.value).toEqual([]);
      });

      it("with several, a tap opens a sheet of which to remove", async () => {
        bookmarks.value = [bm({ id: "whole" }), bm({ id: "pass", label: "Revenue", selection: "Revenue is up." })];
        setup(messages, {}, true);
        fireEvent.click(screen.getByTestId("bookmark-ribbon"));
        const sheet = screen.getByRole("dialog", { name: "Bookmarks" });
        fireEvent.click(within(sheet).getByRole("button", { name: "Remove Bookmark" }));
        await waitFor(() => expect(api.deleteBookmark).toHaveBeenCalledWith("whole"));
        expect(bookmarks.value.map((b) => b.id)).toEqual(["pass"]);
      });
    });

    it("with several bookmarks on one message, offers which to remove", async () => {
      bookmarks.value = [bm({ id: "whole" }), bm({ id: "pass", label: "Revenue", selection: "Revenue is up." })];
      setup();
      const ribbons = within(reply("Revenue is up.")).getAllByTestId("bookmark-ribbon");
      expect(ribbons).toHaveLength(1);
      fireEvent.pointerDown(ribbons[0]!, { button: 0, ctrlKey: false });
      expect(await screen.findByRole("menuitem", { name: "Remove Bookmark" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Remove All" })).toBeTruthy();
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove Passage “Revenue”" }));
      await waitFor(() => expect(api.deleteBookmark).toHaveBeenCalledWith("pass"));
      expect(bookmarks.value.map((b) => b.id)).toEqual(["whole"]);
    });
  });
});
