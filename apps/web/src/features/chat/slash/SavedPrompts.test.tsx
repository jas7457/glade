/** Saved prompts in the composer's `/` menu (I-098): listed per project, picking inserts the text. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { createMemoryRouter, RouterProvider } from "react-router";
import { defaultSessionState, defaultSettings, type SavedPrompt, type SlashCommand } from "@glade/protocol";
import { TooltipProvider } from "@/ui";
import { sessions, settings, workspaces } from "@/state/store";
import { makeSession, makeWorkspace } from "@/test/fixtures";
import { getChatSession, resetChatSessions } from "@/state/chat-session";
import { Composer } from "../Composer";
import { resetFolderCommands } from "./folder-commands";
import { findSavedPrompt, savedPromptCommands, withSavedPrompts } from "./saved-prompts";

vi.mock("@/lib/api", () => ({
  api: {
    prompt: vi.fn(async () => undefined),
    getSession: vi.fn(() => new Promise(() => {})),
    listCommands: vi.fn(async () => HARNESS),
  },
}));
vi.mock("@/lib/api-folder", () => ({
  listFolderCommands: vi.fn(async () => []),
  searchFiles: vi.fn(async () => ({ entries: [], truncated: false })),
  getHarnessDefaults: vi.fn(async () => ({ model: null, thinkingLevel: null })),
}));
vi.mock("@/lib/socket", () => ({ socket: { send: vi.fn(), watch: vi.fn(() => () => {}) } }));

const HARNESS: SlashCommand[] = [{ name: "tests", source: "prompt", description: "pi template named like a saved prompt" }];

const PROMPTS: SavedPrompt[] = [
  { id: "g1", name: "Review diff", description: "Careful review", body: "Review this diff for bugs.", projectId: null },
  { id: "g2", name: "Explain", body: "Explain @src/app.ts\nline two", projectId: null },
  { id: "g3", name: "Tests", body: "hidden by the harness command of the same name", projectId: null },
  { id: "p1", name: "Deploy", body: "Deploy checklist", projectId: "proj" },
  { id: "o1", name: "Other", body: "other project", projectId: "elsewhere" },
];

const { api } = await import("@/lib/api");

const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const type = (value: string) => fireEvent.input(box(), { target: { value } });
const key = (k: string) => fireEvent.keyDown(box(), { key: k });
const options = () => screen.queryAllByRole("option").map((o) => o.textContent ?? "");

async function openChat() {
  const store = getChatSession("c1");
  store.status.value = "ready";
  store.state.value = { ...defaultSessionState(), model: { provider: "a", id: "m" } };
  const router = createMemoryRouter([{ path: "/", element: <TooltipProvider><Composer chatId="c1" /></TooltipProvider> }], { initialEntries: ["/"] });
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(getChatSession("c1").commands.value).toEqual(HARNESS));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetChatSessions();
  resetFolderCommands();
  settings.value = { ...defaultSettings(), prompts: PROMPTS };
  workspaces.value = [makeWorkspace({ id: "w1", projectId: "proj" })];
  sessions.value = [makeSession({ id: "c1", workspaceId: "w1" })];
});

describe("saved prompts helpers", () => {
  it("offers the project's prompts first, then global ones; never other projects'", () => {
    expect(savedPromptCommands(PROMPTS, "proj").map((c) => c.name)).toEqual(["deploy", "review-diff", "explain", "tests"]);
    expect(savedPromptCommands(PROMPTS, null).map((c) => c.name)).toEqual(["review-diff", "explain", "tests"]);
    expect(savedPromptCommands(PROMPTS, null)[1]).toEqual({ name: "explain", description: "Explain @src/app.ts", source: "saved" });
    expect(findSavedPrompt(PROMPTS, "proj", "deploy")?.id).toBe("p1");
    expect(findSavedPrompt(PROMPTS, null, "deploy")).toBeNull();
    const merged = withSavedPrompts(HARNESS, savedPromptCommands(PROMPTS, null));
    expect(merged.filter((c) => c.name === "tests")).toEqual([HARNESS[0]]);
  });
});

describe("saved prompts in the slash menu", () => {
  it("lists them in their own group", async () => {
    await openChat();
    type("/");
    const groups = screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Built-in", "Saved Prompts", "Prompts"]);
    const saved = screen.getByRole("group", { name: "Saved Prompts" }).textContent ?? "";
    expect(saved).toContain("/deploy");
    expect(saved).toContain("/review-diffCareful review");
    expect(saved).not.toContain("/other");
    expect(saved).not.toContain("/tests");
  });

  it("picking one inserts its text without sending", async () => {
    await openChat();
    type("/review");
    expect(options()).toEqual([expect.stringContaining("/review-diff")]);
    key("Enter"); // completes the highlighted entry
    expect(box().value).toBe("Review this diff for bugs.");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(api.prompt).not.toHaveBeenCalled();

    type("/deplo");
    fireEvent.click(screen.getByRole("option", { name: /\/deploy/ }));
    expect(box().value).toBe("Deploy checklist");
    expect(api.prompt).not.toHaveBeenCalled();
  });

  it("typed in full (with extra text) and sent, it's inserted instead", async () => {
    await openChat();
    type("/explain the parser too");
    key("Enter");
    await waitFor(() => expect(box().value).toBe("Explain @src/app.ts\nline two\n\nthe parser too"));
    expect(api.prompt).not.toHaveBeenCalled();
  });
});
