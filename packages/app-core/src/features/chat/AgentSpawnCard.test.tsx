/** I-145: a spawn call shows its agent card at once, as a placeholder, and fills it in place. */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/preact";
import type { ToolCallBlock } from "@glade/protocol";
import { AgentSpawnCard } from "./AgentSpawnCard";
import { SpawnLinksContext, type SpawnLinksValue } from "./spawn-context";
import { NO_SPAWN_LINKS, type SpawnLink } from "./agent-spawns";
import type { ToolCallPart, ToolCallStatus } from "./grouping";

const spawnCall: ToolCallBlock = {
  type: "toolCall",
  id: "c1",
  name: "spawn_agent",
  kind: "task",
  input: { agentName: "t3-research", description: "Research T3 in depth", agentDefinition: "worker" },
  args: { name: "t3-research", task: "Research T3 in depth\nand report back", agent: "worker" },
};
const part = (status: ToolCallStatus): ToolCallPart => ({
  type: "tool",
  key: "c1",
  call: spawnCall,
  result: status === "done" ? { toolCallId: "c1", toolName: "spawn_agent", status: "done", output: "Spawned" } : undefined,
  status,
});
const noLinks: SpawnLinksValue = { links: NO_SPAWN_LINKS, subagents: [], refs: [] };
const link: SpawnLink = { ref: { name: "t3-research", sessionId: "s1", displayName: "Maya", color: "violet", spawnedAt: Date.now() }, messages: [] };
const linked: SpawnLinksValue = { links: { byCall: new Map([["c1", link]]), hidden: new Set() }, subagents: [], refs: [link.ref] };

const view = (value: SpawnLinksValue, p: ToolCallPart) => (
  <SpawnLinksContext.Provider value={value}>
    <AgentSpawnCard part={p} />
  </SpawnLinksContext.Provider>
);

describe("AgentSpawnCard while spawning (I-145)", () => {
  it("shows a placeholder card with the functional name and agent definition, not the task", () => {
    const { container } = render(view(noLinks, part("running")));
    const card = container.querySelector('[data-role="agent-spawn"]')!;
    expect(card.getAttribute("data-kind")).toBe("starting");
    expect(screen.getByRole("status", { name: "Starting an agent: t3-research (worker)" })).toBeTruthy();
    expect(card.textContent).toContain("t3-research· worker");
    expect(card.textContent).toContain("Starting an agent…");
    expect(container.querySelector("[data-status-marker=working]")).not.toBeNull();
    expect(container.textContent).not.toContain("Research T3");
  });

  it("also while the call's arguments are still streaming", () => {
    const { container } = render(view(noLinks, part("streaming")));
    expect(container.querySelector('[data-kind="starting"]')).not.toBeNull();
  });

  it("becomes the agent's card in place once the spawn returns: one card, no tool row", () => {
    const { container, rerender } = render(view(noLinks, part("running")));
    rerender(view(linked, part("done")));
    const cards = container.querySelectorAll('[data-role="agent-spawn"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.getAttribute("data-agent-color")).toBe("violet");
    expect(cards[0]!.textContent).toContain("Maya");
    expect(cards[0]!.textContent).toContain("· t3-research");
    expect(container.textContent).not.toContain("Starting an agent…");
  });

  it("falls back to a tool row naming the agent when the call ends without an agent", () => {
    const { container } = render(view(noLinks, part("done")));
    expect(container.querySelector('[data-role="agent-spawn"]')).toBeNull();
    expect(container.textContent).toContain("Started agent t3-research");
  });
});
