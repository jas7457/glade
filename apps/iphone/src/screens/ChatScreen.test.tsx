/** The phone chat screen (I-164): sub-agents as cards; tapping one opens it full screen with Back to the parent. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import { createMemoryRouter, RouterProvider } from "react-router";
import { defaultSessionState, defaultSettings, type HarnessCapabilities, type ModelInfo } from "@glade/protocol";
import { TooltipProvider } from "@glade/app-core/ui";
import { bookmarks, models, projects, sessions, settings, workspaces } from "@glade/app-core/state/store";
import { api } from "@glade/app-core/lib/api";
import { pendingJump } from "@glade/app-core/features/chat/jump-to-message";
import { act, waitFor, within } from "@testing-library/preact";
import { getChatSession, resetChatSessions } from "@glade/app-core/state/chat-session";
import { harnesses } from "@glade/app-core/state/harnesses";
import { makeProject, makeSession, makeWorkspace } from "@glade/app-core/test/fixtures";
import { connections } from "@glade/app-core/state/env-registry";
import { savedEnvironments } from "@glade/app-core/state/saved-environments";
import { fakeEnv } from "~/test/fake-env";
import { setVoiceEngine } from "~/voice/engine-provider";
import { createFakeVoiceEngine } from "~/voice/fake-engine";
import { closeVoiceMode, voiceMode } from "~/voice/voice-mode";
import { ChatScreen } from "./ChatScreen";

vi.mock("@glade/app-core/lib/api", () => ({
  api: {
    getSession: vi.fn(() => new Promise(() => {})),
    listCommands: vi.fn(() => new Promise(() => {})),
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    createBookmark: vi.fn(),
    deleteBookmark: vi.fn(async () => undefined),
  },
  request: vi.fn(async () => ({ isRepo: false })),
}));
vi.mock("@glade/app-core/lib/socket", () => ({ socket: { send: vi.fn(), watch: vi.fn(() => () => {}) } }));

Element.prototype.scrollTo ??= function () {};

function renderAt(url: string) {
  const router = createMemoryRouter([{ path: "/e/:envId/chats/:chatId", element: <ChatScreen /> }], { initialEntries: [url] });
  render(
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>,
  );
  return router;
}

function model(id: string, name: string): ModelInfo {
  return { provider: "anthropic", id, name, reasoning: true, thinkingLevels: ["off", "low", "medium", "high"], input: ["text"], contextWindow: 200000, maxTokens: 8192 } as ModelInfo;
}

beforeEach(() => {
  resetChatSessions();
  harnesses.value = null;
  settings.value = defaultSettings();
  models.value = [];
  projects.value = [makeProject({ id: "p" })];
  workspaces.value = [makeWorkspace({ id: "w", projectId: "p", title: "Fix login" })];
  sessions.value = [
    makeSession({ id: "m1", workspaceId: "w", title: "Fix login", createdAt: 1, status: "working" }),
    makeSession({ id: "a1", workspaceId: "w", kind: "subagent", parentSessionId: "m1", agentName: "reviewer", agentDisplayName: "Maya", title: "reviewer", createdAt: 3, status: "working" }),
  ];
});

describe("ChatScreen", () => {
  it("shows the chat's title, working indicator and its sub-agents as cards", () => {
    renderAt("/e/env1/chats/w");
    expect(screen.getByText("Fix login")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Working" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Chats" })).toBeTruthy();
    const cards = screen.getByRole("region", { name: "Sub-agents" });
    expect(cards.textContent).toContain("Maya");
  });

  it("tapping a sub-agent card opens it full screen; Back returns to the parent chat", () => {
    const router = renderAt("/e/env1/chats/w");
    fireEvent.click(screen.getByRole("button", { name: /^Open Maya/ }));
    expect(router.state.location.pathname).toBe("/e/env1/chats/w");
    expect(router.state.location.search).toBe("?tab=a1");
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Chats" })).toBeNull();
    expect(screen.getByText("Maya")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(router.state.location.search).toBe("");
    expect(screen.getByRole("button", { name: "Chats" })).toBeTruthy();
  });

  it("a sub-agent opened by URL goes back to its parent", () => {
    const router = renderAt("/e/env1/chats/w?tab=a1");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(router.state.location.search).toBe("?tab=m1");
  });

  it("shows the model and thinking level under the title; tapping it opens the Model & Thinking sheet (I-172)", () => {
    models.value = [model("opus", "Opus"), model("sonnet", "Sonnet")];
    const store = getChatSession("m1");
    store.status.value = "ready";
    store.state.value = { ...defaultSessionState(), model: { provider: "anthropic", id: "opus" }, thinkingLevel: "medium", thinkingLevels: ["off", "low", "medium", "high"] };
    renderAt("/e/env1/chats/w");
    const line = screen.getByRole("button", { name: "Model and thinking: Opus, Medium" });
    expect(line.textContent).toContain("Opus · Medium");
    // The header is the one place for it: the composer's toolbar has no model chip (I-222).
    expect(screen.queryAllByRole("button", { name: /^Model and thinking:/ })).toHaveLength(1);
    fireEvent.click(line);
    expect(screen.getByText("Model & Thinking")).toBeTruthy();
    expect(screen.getByRole("listbox", { name: "Thinking" })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Sonnet/ })).toBeTruthy();
  });

  it("leads the line with the chat's agent when its Mac offers two or more (I-176)", () => {
    const caps = { models: true } as HarnessCapabilities;
    harnesses.value = [
      { id: "fake", label: "Fake", isDefault: true, capabilities: caps },
      { id: "claude", label: "Claude Code", isDefault: false, capabilities: caps },
    ];
    models.value = [model("opus", "Opus")];
    const store = getChatSession("m1");
    store.status.value = "ready";
    store.state.value = { ...defaultSessionState(), model: { provider: "anthropic", id: "opus" }, thinkingLevel: "medium", thinkingLevels: ["off", "low", "medium", "high"] };
    renderAt("/e/env1/chats/w");
    const line = screen.getByRole("button", { name: "Fake. Model and thinking: Opus, Medium" });
    expect(line.textContent).toBe("Fake · Opus · Medium");
  });

  it("no agent in the line when the Mac offers one (I-176)", () => {
    harnesses.value = [{ id: "fake", label: "Fake", isDefault: true, capabilities: { models: true } as HarnessCapabilities }];
    models.value = [model("opus", "Opus")];
    const store = getChatSession("m1");
    store.status.value = "ready";
    store.state.value = { ...defaultSessionState(), model: { provider: "anthropic", id: "opus" }, thinkingLevel: "medium", thinkingLevels: ["off", "low", "medium", "high"] };
    renderAt("/e/env1/chats/w");
    expect(screen.getByRole("button", { name: "Model and thinking: Opus, Medium" }).textContent).toBe("Opus · Medium");
  });

  it("agents that choose their own model: just the agent's name, when there are several (I-176)", () => {
    harnesses.value = [
      { id: "fake", label: "Fake", isDefault: true, capabilities: { models: false } as HarnessCapabilities },
      { id: "pi", label: "pi", isDefault: false, capabilities: { models: true } as HarnessCapabilities },
    ];
    const store = getChatSession("m1");
    store.status.value = "ready";
    store.state.value = { ...defaultSessionState(), model: { provider: "anthropic", id: "opus" } };
    renderAt("/e/env1/chats/w");
    expect(screen.queryByRole("button", { name: /Model/ })).toBeNull();
    expect(screen.getByTitle("Runs on Fake").textContent).toBe("Fake");
  });

  it("no model line for agents that choose their own model", () => {
    harnesses.value = [{ id: "fake", label: "Fake", isDefault: true, capabilities: { models: false } as HarnessCapabilities }];
    const store = getChatSession("m1");
    store.status.value = "ready";
    store.state.value = { ...defaultSessionState(), model: { provider: "anthropic", id: "opus" } };
    renderAt("/e/env1/chats/w");
    expect(screen.queryByRole("button", { name: /^Model/ })).toBeNull();
  });
  it("when the chat's Mac drops (its chats leave the store), says so with Retry instead of an empty screen", () => {
    connections.value = [fakeEnv("m2", "MacBook Air", "offline")];
    savedEnvironments.value = [{ id: "m2", name: "MacBook Air", urls: ["http://m2.test:4327"], token: "t" }];
    renderAt("/e/m2/chats/gone");
    expect(screen.getByText("Can't reach MacBook Air")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    connections.value = [];
    savedEnvironments.value = [];
  });

  it("the waveform next to Send opens voice mode for this chat", () => {
    setVoiceEngine(createFakeVoiceEngine({ wordMs: 0 }));
    renderAt("/e/env1/chats/w");
    fireEvent.click(screen.getByRole("button", { name: "Voice mode" }));
    expect(voiceMode.value?.sessionId).toBe("m1");
    closeVoiceMode();
    setVoiceEngine(null);
  });
});

describe("ChatScreen bookmarks (I-203)", () => {
  afterEach(() => {
    delete (window as { __GLADE_IPHONE__?: boolean }).__GLADE_IPHONE__;
  });
  const reply = { id: "r1", role: "assistant" as const, content: [{ type: "text" as const, text: "## Numbers\n\nQ3 is up." }], timestamp: 2000 };
  beforeEach(() => {
    vi.useRealTimers();
    bookmarks.value = [];
    pendingJump.value = null;
    (window as { __GLADE_IPHONE__?: boolean }).__GLADE_IPHONE__ = true;
    const store = getChatSession("m1");
    store.status.value = "ready";
    store.state.value = defaultSessionState();
    store.transcript.value = { messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "numbers?" }], timestamp: 1000 }, reply], toolResults: {} };
  });

  it("long-press a reply → Bookmark; the nav bar then shows the count and lists it; tapping jumps", async () => {
    vi.mocked(api.createBookmark).mockImplementation(async (body) => ({
      id: "b1",
      sessionId: body.sessionId,
      workspaceId: "w",
      message: body.message,
      label: "Numbers",
      labelSource: "auto",
      excerpt: "Numbers Q3 is up.",
      createdAt: 1,
    }));
    renderAt("/e/env1/chats/w");
    expect(screen.queryByRole("button", { name: /bookmark/ })).toBeNull();
    vi.useFakeTimers();
    fireEvent.touchStart(screen.getByText("Q3 is up."));
    act(() => void vi.advanceTimersByTime(600));
    vi.useRealTimers();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Agent Reply" })).getByRole("option", { name: "Bookmark" }));
    await waitFor(() => expect(api.createBookmark).toHaveBeenCalledWith({ sessionId: "m1", message: { role: "assistant", timestamp: 2000 }, text: "## Numbers\n\nQ3 is up." }));
    fireEvent.click(await screen.findByRole("button", { name: "1 bookmark" }));
    const sheet = screen.getByRole("dialog", { name: "Bookmarks" });
    fireEvent.click(within(sheet).getByText("Numbers"));
    // The transcript on screen takes the jump: the reply is flashed.
    await waitFor(() => expect(screen.getByText("Q3 is up.").closest(".pi-jump-highlight")).toBeTruthy());
    expect(pendingJump.value).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Bookmarks" })).toBeNull();
  });
});
