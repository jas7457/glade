/** The phone chat screen (I-164): sub-agents as cards; tapping one opens it full screen with Back to the parent. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import { createMemoryRouter, RouterProvider } from "react-router";
import { defaultSessionState, defaultSettings, type HarnessCapabilities, type ModelInfo } from "@glade/protocol";
import { TooltipProvider } from "@glade/app-core/ui";
import { models, projects, sessions, settings, workspaces } from "@glade/app-core/state/store";
import { getChatSession, resetChatSessions } from "@glade/app-core/state/chat-session";
import { harnesses } from "@glade/app-core/state/harnesses";
import { makeProject, makeSession, makeWorkspace } from "@glade/app-core/test/fixtures";
import { connections } from "@glade/app-core/state/env-registry";
import { savedEnvironments } from "@glade/app-core/state/saved-environments";
import { fakeEnv } from "~/test/fake-env";
import { ChatScreen } from "./ChatScreen";

vi.mock("@glade/app-core/lib/api", () => ({
  api: {
    getSession: vi.fn(() => new Promise(() => {})),
    listCommands: vi.fn(() => new Promise(() => {})),
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
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
    fireEvent.click(line);
    expect(screen.getByText("Model & Thinking")).toBeTruthy();
    expect(screen.getByRole("listbox", { name: "Thinking" })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Sonnet/ })).toBeTruthy();
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
});
