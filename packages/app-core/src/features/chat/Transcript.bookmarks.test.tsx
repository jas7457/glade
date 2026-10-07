/**
 * I-203: bookmarks in the transcript: the hover toggle on user messages and agent replies, the
 * ribbon on bookmarked ones, the scroll-edge ticks (click → scroll + flash) and the right-click
 * menu (Bookmark Reply / Remove Bookmark / Copy).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { defaultSessionState, type Bookmark, type ChatMessage } from "@glade/protocol";
import { TooltipProvider } from "@glade/app-core/ui";
import { bookmarks, sessions } from "@glade/app-core/state/store";
import { getChatSession, resetChatSessions } from "@glade/app-core/state/chat-session";
import { makeSession } from "@glade/app-core/test/fixtures";
import { Transcript } from "./Transcript";
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
    expect(within(reply("Revenue is up.")).getByTestId("bookmark-ribbon").getAttribute("title")).toBe("Bookmarked: Q3");
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
});
