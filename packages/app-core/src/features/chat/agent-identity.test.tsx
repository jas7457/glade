/** I-218 / I-217: a sub-agent's icon, "Brandon · scout" and its harness when it isn't the parent's. */
import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/preact";
import type { SessionAgentState, ToolCallBlock } from "@glade/protocol";
import { makeSession } from "@glade/app-core/test/fixtures";
import { sessions } from "@glade/app-core/state/store";
import { harnesses } from "@glade/app-core/state/harnesses";
import { TabStrip } from "@glade/app-core/ui";
import { AgentIconGlyph } from "@glade/app-core/ui";
import { agentIdentity, refAgentIdentity, sessionAgentIdentity } from "./agent-identity";
import { AgentName } from "./AgentName";
import { AgentSpawnCard } from "./AgentSpawnCard";
import { SpawnLinksContext, type SpawnLinksValue } from "./spawn-context";
import type { SpawnLink } from "./agent-spawns";
import { agentChip, chipTooltip } from "@glade/app-core/features/workspace/agent-chips";

const agentState = (over: Partial<SessionAgentState> = {}): SessionAgentState => ({
  status: "working",
  agent: "scout",
  task: "Find the auth code",
  keepOpenReason: null,
  userEngaged: false,
  closing: false,
  doneAt: null,
  result: null,
  ...over,
});

afterEach(() => {
  sessions.value = [];
  harnesses.value = null;
});

describe("agent identity", () => {
  it("shows the definition's name instead of the functional name, and its icon", () => {
    const id = agentIdentity({ id: "s1", name: "find-auth", displayName: "Brandon", color: "teal", definition: "scout", icon: "search" });
    expect(id).toEqual({ displayName: "Brandon", role: "scout", color: "teal", icon: "search", harness: null });
    // Unknown icons render nothing; no definition = the functional name, as before.
    expect(agentIdentity({ id: "s1", name: "reviewer", displayName: "Maya", icon: "nope" })).toMatchObject({ role: "reviewer", icon: null });
  });

  it("names the harness only when it differs from the parent's", () => {
    expect(agentIdentity({ id: "s", name: "a", harness: "claude", parentHarness: "pi" }).harness).toBe("claude");
    expect(agentIdentity({ id: "s", name: "a", harness: "pi", parentHarness: "pi" }).harness).toBeNull();
    expect(agentIdentity({ id: "s", name: "a", harness: "claude" }).harness).toBeNull();
  });

  it("reads a session's icon, definition and its parent's harness from the store", () => {
    const parent = makeSession({ id: "m", harness: "pi" });
    const child = makeSession({
      id: "c",
      kind: "subagent",
      parentSessionId: "m",
      harness: "claude",
      agentName: "find-auth",
      agentDisplayName: "Brandon",
      agentIcon: "search",
      agent: agentState(),
    });
    sessions.value = [parent, child];
    expect(sessionAgentIdentity(child)).toMatchObject({ displayName: "Brandon", role: "scout", icon: "search", harness: "claude" });
    expect(sessionAgentIdentity(child, "claude").harness).toBeNull();
  });

  it("keeps a closed agent's icon, definition and harness from its record", () => {
    const id = refAgentIdentity({ name: "find-auth", sessionId: "x", displayName: "Brandon", color: "teal", icon: "search", agent: "scout", harness: "codex", spawnedAt: 1 }, "pi");
    expect(id).toMatchObject({ displayName: "Brandon", role: "scout", icon: "search", harness: "codex" });
  });
});

describe("rendering", () => {
  it("AgentName: icon, name, greyed definition and a harness badge", () => {
    harnesses.value = [{ id: "claude", label: "Claude Code", isDefault: false, capabilities: {} } as never];
    const identity = agentIdentity({ id: "s", name: "find-auth", displayName: "Brandon", definition: "scout", icon: "search", harness: "claude", parentHarness: "pi" });
    const { container } = render(
      <span data-agent-color="teal">
        <AgentName identity={identity} />
      </span>,
    );
    expect(container.querySelector('[data-agent-icon="search"]')).not.toBeNull();
    expect(container.textContent).toBe("Brandon· scoutClaude Code");
    expect(screen.getByTitle("Runs on Claude Code")).toBeTruthy();
  });

  it("AgentName without an icon or another harness looks as before", () => {
    const { container } = render(<AgentName identity={agentIdentity({ id: "s", name: "reviewer", displayName: "Maya" })} />);
    expect(container.querySelector("[data-agent-icon]")).toBeNull();
    expect(container.textContent).toBe("Maya· reviewer");
  });

  it("the spawn card shows the definition, icon and harness of a closed agent", () => {
    const call: ToolCallBlock = { type: "toolCall", id: "c1", name: "spawn_agent", kind: "task", input: { agentName: "find-auth" }, args: {} };
    const link: SpawnLink = {
      ref: { name: "find-auth", sessionId: "gone", displayName: "Brandon", color: "teal", icon: "search", agent: "scout", harness: "codex", spawnedAt: 1 },
      messages: [],
    };
    const value: SpawnLinksValue = { links: { byCall: new Map([["c1", link]]), hidden: new Set() }, subagents: [], refs: [link.ref], parentHarness: "pi" };
    const { container } = render(
      <SpawnLinksContext.Provider value={value}>
        <AgentSpawnCard part={{ type: "tool", key: "c1", call, status: "done", result: { toolCallId: "c1", toolName: "spawn_agent", status: "done", output: "" } }} />
      </SpawnLinksContext.Provider>,
    );
    const card = container.querySelector('[data-role="agent-spawn"]')!;
    expect(card.querySelector('[data-agent-icon="search"]')).not.toBeNull();
    expect(card.textContent).toContain("Brandon· scoutCodex");
  });

  it("chips show the icon and name the harness in the tooltip", () => {
    sessions.value = [makeSession({ id: "m", harness: "pi" })];
    const child = makeSession({ id: "c", kind: "subagent", parentSessionId: "m", harness: "codex", agentName: "x", agentDisplayName: "Bea", agentIcon: "bug", agent: agentState(), createdAt: 0 });
    const chip = agentChip(child, null, [], 1_000);
    expect(chip.identity.icon).toBe("bug");
    expect(chipTooltip(chip, false)).toContain("Runs on Codex");
  });

  it("tabs show a title icon", () => {
    const { container } = render(
      <TabStrip
        label="Agents"
        activeId="c"
        onSelect={() => {}}
        tabs={[{ id: "c", title: "Brandon", subtitle: "scout", status: "idle", agentColor: "teal", titleIcon: <AgentIconGlyph icon="search" /> }]}
      />,
    );
    expect(container.querySelector('[role="tab"] [data-agent-icon="search"]')).not.toBeNull();
    expect(container.querySelector('[role="tab"]')!.textContent).toContain("Brandon · scout");
  });
});
