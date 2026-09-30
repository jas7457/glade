import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { RouterProvider, createMemoryRouter } from "react-router";
import type { HarnessInfo, ModelInfo } from "@glade/protocol";

vi.mock("@glade/app-core/state/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@glade/app-core/state/actions")>()),
  createWorkspace: vi.fn(async (req: { projectId: string | null }) => ({
    workspace: { id: "new-ws", projectId: req.projectId, environmentId: "m2" },
    session: { session: { id: "s1" } },
  })),
}));
vi.mock("@glade/app-core/features/chat/slash/folder-commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@glade/app-core/features/chat/slash/folder-commands")>()),
  useFolderCommands: () => [],
}));

import { createWorkspace } from "@glade/app-core/state/actions";
import { connections } from "@glade/app-core/state/env-registry";
import { newChatHarness } from "@glade/app-core/state/harnesses";
import { savedEnvironments } from "@glade/app-core/state/saved-environments";
import { projects } from "@glade/app-core/state/store";
import { makeProject } from "@glade/app-core/test/fixtures";
import { chatPath } from "@glade/app-core/app/routes";
import { TooltipProvider } from "@glade/app-core/ui";
import { paths } from "~/app/routes";
import { fakeEnv } from "~/test/fake-env";
import { setVoiceEngine } from "~/voice/engine-provider";
import { createFakeVoiceEngine } from "~/voice/fake-engine";
import { closeVoiceMode, voiceMode } from "~/voice/voice-mode";
import { NewChatScreen, defaultNewChatEnv } from "./NewChatScreen";

const MODELS: ModelInfo[] = [{ provider: "anthropic", id: "haiku", name: "Claude Haiku", thinkingLevels: ["off", "low"], input: ["text"] }];

function harness(id: string, label: string, isDefault = false, models = true): HarnessInfo {
  return { id, label, isDefault, capabilities: { models } } as HarnessInfo;
}

function renderNew(entry = paths.newChat()) {
  const router = createMemoryRouter(
    [
      { path: "/new", element: <NewChatScreen /> },
      { path: "*", element: <div>elsewhere</div> },
    ],
    { initialEntries: ["/", entry], initialIndex: 1 },
  );
  render(
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>,
  );
  return router;
}

describe("NewChatScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as { __GLADE_IPHONE__?: boolean }).__GLADE_IPHONE__ = true;
    newChatHarness.value = null;
    const m1 = fakeEnv("m1", "Studio");
    const m2 = fakeEnv("m2", "Air");
    for (const m of [m1, m2]) m.shell.models.value = MODELS;
    connections.value = [m1, m2];
    savedEnvironments.value = [
      { id: "m1", name: "Studio", urls: ["http://m1.test"], token: "t" },
      { id: "m2", name: "Air", urls: ["http://m2.test"], token: "t" },
    ];
    projects.value = [makeProject({ id: "p1", name: "Alpha", environmentId: "m1" }), makeProject({ id: "p2", name: "Beta", environmentId: "m2" })];
  });
  afterEach(() => {
    delete (window as { __GLADE_IPHONE__?: boolean }).__GLADE_IPHONE__;
  });

  it("shows the empty state, picks Mac and project from the chips, sends, then replaces itself with the chat", async () => {
    const router = renderNew();
    expect(screen.getByRole("heading", { name: "What should we work on?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mac: Studio" }));
    fireEvent.click(screen.getByRole("button", { name: /^Air/ }));
    fireEvent.click(screen.getByRole("button", { name: "Project: none" }));
    // Only that Mac's projects are offered.
    expect(screen.queryByRole("button", { name: /Alpha/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Beta/ }));
    expect(screen.getByRole("button", { name: "Project: Beta" })).toBeTruthy();

    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText("Message"), { target: { value: "Hello there" } });
    await act(async () => {
      fireEvent.click(send);
    });
    await waitFor(() => expect(router.state.location.pathname).toBe(chatPath({ id: "new-ws", projectId: "p2", environmentId: "m2" })));
    expect(createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p2", prompt: "Hello there" }), "m2");
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("voice mode: the first utterance starts the chat (like Send), then the conversation continues in it", async () => {
    const engine = createFakeVoiceEngine({ wordMs: 0, hearMs: 0 });
    setVoiceEngine(engine);
    const router = renderNew(`${paths.newChat()}?env=m2&project=p2`);
    fireEvent.click(screen.getByRole("button", { name: "Voice mode" }));
    expect(voiceMode.value?.sessionId).toBeNull();
    await waitFor(() => expect(engine.listening).toBe(true));
    await act(() => engine.hear("build a todo app"));
    await waitFor(() => expect(router.state.location.pathname).toBe(chatPath({ id: "new-ws", projectId: "p2", environmentId: "m2" })));
    expect(createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p2", prompt: "build a todo app" }), "m2");
    expect(voiceMode.value?.sessionId).toBe("s1");
    expect(engine.listening).toBe(true);
    closeVoiceMode();
    setVoiceEngine(null);
  });

  it("keeps ?env=&project= preselection", () => {
    renderNew(`${paths.newChat()}?env=m2&project=p2`);
    expect(screen.getByRole("button", { name: "Mac: Air" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Project: Beta" })).toBeTruthy();
  });

  it("offers the agent as a section of the Model & Thinking sheet when the Mac has several", () => {
    connections.value[0]!.shell.harnesses.value = [harness("pi", "Pi", true), harness("acp:claude", "Claude Code", false, false)];
    renderNew();
    fireEvent.click(screen.getByRole("button", { name: /^Model and thinking:/ }));
    expect(screen.getByRole("listbox", { name: "Agent" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /Claude Code/ }));
    expect(newChatHarness.value).toBe("acp:claude");
    // That agent picks its own model: the pill shows the agent, and its sheet still switches back.
    fireEvent.click(screen.getByRole("button", { name: "Agent: Claude Code" }));
    fireEvent.click(screen.getByRole("option", { name: /^Pi/ }));
    expect(newChatHarness.value).toBeNull();
  });

  it("hides the Mac chip with one Mac and defaults to a connected one", () => {
    connections.value = [fakeEnv("m1", "Studio")];
    renderNew();
    expect(screen.queryByRole("button", { name: /^Mac:/ })).toBeNull();
    expect(screen.queryByRole("listbox", { name: "Agent" })).toBeNull();
    connections.value = [fakeEnv("a", "A", "offline"), fakeEnv("b", "B")];
    expect(defaultNewChatEnv(null)).toBe("b");
    expect(defaultNewChatEnv("a")).toBe("a");
  });

  it("says what to check when the Mac can't be reached, with Retry (I-170)", () => {
    const studio = fakeEnv("m1", "Studio", "offline");
    const retry = vi.fn();
    studio.retry = retry;
    connections.value = [studio];
    renderNew(`${paths.newChat()}?env=m1`);
    expect(screen.getByRole("status").textContent).toContain("Can't reach Studio");
    expect(screen.getByText("Make sure it's awake with Glade open, and Tailscale is on on both.")).toBeTruthy();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).placeholder).toBe("Can't reach Studio");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
