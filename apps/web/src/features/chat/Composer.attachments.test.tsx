import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { createMemoryRouter, RouterProvider } from "react-router";
import { defaultSessionState, defaultSettings, emptyTranscript, type CreateWorkspaceResponse, type ModelInfo } from "@glade/protocol";
import { TooltipProvider } from "@/ui";
import { models, settings } from "@/state/store";
import { makeSession, makeWorkspace } from "@/test/fixtures";
import { getChatSession, resetChatSessions } from "@/state/chat-session";
import { formatBytes, splitAttachableFiles } from "./composer-utils";
import { Composer } from "./Composer";

vi.mock("@/lib/api", () => ({
  api: {
    createWorkspace: vi.fn(),
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    getSession: vi.fn(() => new Promise(() => {})),
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(async () => undefined),
    respondToUi: vi.fn(async () => undefined),
    listCommands: vi.fn(async () => []),
  },
}));
vi.mock("@/lib/api-folder", () => ({
  listFolderCommands: vi.fn(async () => []),
  searchFiles: vi.fn(async () => ({ entries: [], truncated: false })),
  getHarnessDefaults: vi.fn(async () => ({ model: null, thinkingLevel: null })),
}));
vi.mock("@/lib/socket", () => ({ socket: { send: vi.fn(), watch: vi.fn(() => () => {}) } }));
vi.mock("@/state/attachments", () => ({
  attachFilesToText: vi.fn(async (sessionId: string, text: string, files: File[]) =>
    [text, ...files.map((f) => `Attached file: /data/attachments/${sessionId}/${f.name}`)].filter(Boolean).join("\n"),
  ),
}));

// jsdom has no createImageBitmap: images are "read" as their name, base64-encoded.
vi.mock("./image-resize", () => ({
  prepareImage: vi.fn(async (file: File) => ({ mimeType: file.type, data: btoa(file.name), width: 1, height: 1, bytes: file.size })),
}));

const { api } = await import("@/lib/api");
const { attachFilesToText } = await import("@/state/attachments");

const MODELS: ModelInfo[] = [{ provider: "anthropic", id: "haiku", name: "Claude Haiku", thinkingLevels: ["off"], input: ["text", "image"] }];

function renderAt(ui: preact.ComponentChildren) {
  const router = createMemoryRouter(
    [
      { path: "/", element: <TooltipProvider>{ui}</TooltipProvider> },
      { path: "/chats/:chatId", element: <div>chat page</div> },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

function readyChat(chatId: string) {
  const store = getChatSession(chatId);
  store.status.value = "ready";
  store.state.value = { ...defaultSessionState(), model: { provider: "anthropic", id: "haiku" }, thinkingLevels: ["off"], isRunning: false };
  return store;
}

const pdf = (name = "report.pdf", size = 10) => new File(["x".repeat(size)], name, { type: "application/pdf" });

function drop(files: File[]) {
  const box = screen.getByRole("textbox", { name: "Message" }).parentElement!;
  fireEvent.drop(box, { dataTransfer: { files, types: ["Files"] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetChatSessions();
  settings.value = defaultSettings();
  models.value = MODELS;
});

describe("splitAttachableFiles / formatBytes", () => {
  it("images inline when supported, other files by reference, refuses big files", () => {
    const png = new File(["p"], "a.png", { type: "image/png" });
    const big = pdf("big.pdf", 20);
    const split = splitAttachableFiles([png, pdf(), big], true, 15);
    expect(split.images).toEqual([png]);
    expect(split.files.map((f) => f.name)).toEqual(["report.pdf"]);
    expect(split.tooLarge).toEqual([big]);
    // A model without image input gets images as files.
    expect(splitAttachableFiles([png], false, 15).files.map((f) => f.name)).toEqual(["a.png"]);
  });
  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(50 * 1024 * 1024)).toBe("50 MB");
  });
});

describe("Composer file attachments (I-090)", () => {
  it("shows dropped files as chips, removes one, and sends the rest by reference", async () => {
    readyChat("c1");
    renderAt(<Composer chatId="c1" />);
    drop([pdf("report.pdf"), pdf("notes.txt")]);
    const list = await screen.findByLabelText("Attachments");
    expect(within(list).getByText("report.pdf")).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: "Remove notes.txt" }));
    expect(within(list).queryByText("notes.txt")).toBeNull();

    // Files alone are enough to send.
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() =>
      expect(api.prompt).toHaveBeenCalledWith("c1", { text: "Attached file: /data/attachments/c1/report.pdf", images: undefined, behavior: undefined }),
    );
    expect(vi.mocked(attachFilesToText).mock.calls[0]![2].map((f) => f.name)).toEqual(["report.pdf"]);
    expect(screen.queryByLabelText("Attachments")).toBeNull();
  });

  it("picks any file with the paperclip and keeps the chips when sending fails", async () => {
    readyChat("c1");
    vi.mocked(api.prompt).mockRejectedValueOnce(new Error("boom"));
    renderAt(<Composer chatId="c1" />);
    const input = screen.getByTestId("attach-input") as HTMLInputElement;
    expect(input.accept).toBe("");
    Object.defineProperty(input, "files", { value: [pdf("data.csv")], configurable: true });
    // (testing-library/preact turns fireEvent.change into an input event.)
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await screen.findByText("data.csv");
    fireEvent.input(screen.getByRole("textbox", { name: "Message" }), { target: { value: "look" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.prompt).toHaveBeenCalled());
    await screen.findByText("data.csv");
  });

  it("new chat: creates the chat first, then uploads into its session and prompts", async () => {
    const session = makeSession({ id: "s-new1", workspaceId: "new1" });
    const detail: CreateWorkspaceResponse = {
      workspace: makeWorkspace({ id: "new1" }),
      sessions: [session],
      session: { session, transcript: emptyTranscript(), state: defaultSessionState(), pendingUiRequests: [] },
    };
    vi.mocked(api.createWorkspace).mockResolvedValueOnce(detail);
    const router = renderAt(<Composer projectId={null} />);
    drop([pdf("spec.pdf")]);
    await screen.findByText("spec.pdf");
    fireEvent.input(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Read this" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    await waitFor(() => expect(api.prompt).toHaveBeenCalledWith("s-new1", { text: "Read this\nAttached file: /data/attachments/s-new1/spec.pdf", images: undefined }));
    expect(vi.mocked(api.createWorkspace).mock.calls[0]![0]).toMatchObject({ projectId: null, prompt: undefined, images: undefined });
    await waitFor(() => expect(router.state.location.pathname).toBe("/chats/new1"));
  });
});

describe("Composer pending images (I-115)", () => {
  const png = (name: string) => new File(["p"], name, { type: "image/png" });

  it("opens a pending image large, steps with the arrows, and × removes without opening", async () => {
    readyChat("c1");
    renderAt(<Composer chatId="c1" />);
    drop([png("one.png"), png("two.png")]);
    const list = await screen.findByLabelText("Attachments");
    await within(list).findByRole("button", { name: "Open two.png" });

    fireEvent.click(within(list).getByRole("button", { name: "Open one.png" }));
    const box = await screen.findByTestId("lightbox");
    expect(box.querySelector("img")!.getAttribute("src")).toBe(`data:image/png;base64,${btoa("one.png")}`);
    fireEvent.keyDown(box, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByTestId("lightbox").querySelector("img")!.getAttribute("src")).toBe(`data:image/png;base64,${btoa("two.png")}`));
    fireEvent.keyDown(screen.getByTestId("lightbox"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("lightbox")).toBeNull());

    fireEvent.click(within(list).getByRole("button", { name: "Remove one.png" }));
    expect(screen.queryByTestId("lightbox")).toBeNull();
    expect(within(list).queryByRole("button", { name: "Open one.png" })).toBeNull();
    expect(within(list).getByRole("button", { name: "Open two.png" }).className).toContain("cursor-zoom-in");
  });
});
