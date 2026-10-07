/**
 * I-198: an agent's Version group: installed + newest version, Check Now (forced; opening asks a
 * non-forced check), Update (primary when behind, the command shown), running (spinner + log),
 * waiting for chats (+ Cancel), done, failed (error + log), not installed, another Mac through
 * the device switcher, the `agent_versions` push and the behind count for the Agents dot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import type { AgentUpdateJob, AgentVersionInfo, AgentVersionsStatus } from "@glade/protocol";

const server = vi.hoisted(() => ({ status: null as unknown, afterUpdate: null as unknown, calls: [] as string[], fail: null as null | { status: number; message: string } }));
vi.mock("@glade/app-core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@glade/app-core/lib/api")>();
  return {
    ...actual,
    request: vi.fn(async (method: string, path: string) => {
      server.calls.push(`${method} ${path}`);
      if (server.fail && path.includes("/update")) throw new actual.ApiRequestError(server.fail.status, server.fail.message);
      if (path.endsWith("/update") && server.afterUpdate) server.status = server.afterUpdate;
      return server.status;
    }),
  };
});

import { TooltipProvider } from "@glade/app-core/ui";
import { settingsEnvironmentId } from "@glade/app-core/state/env-registry";
import { agentsBehind, agentVersions, agentVersionsError, agentUpdateErrors, receiveAgentVersionsMessage, waitingText } from "@glade/app-core/state/agent-versions";
import { fakeEnv, resetEnvironmentsForTest, useEnvironments } from "@glade/app-core/test/env-fixtures";
import { AgentVersionGroup } from "./AgentVersion";

const at = "2026-10-05T10:00:00.000Z";

function agent(harness: string, extra: Partial<AgentVersionInfo> = {}): AgentVersionInfo {
  return {
    harness,
    installed: "2.1.280",
    latest: "2.1.293",
    state: "behind",
    source: "Claude Code latest channel",
    checkedAt: at,
    updateCommand: `${harness} update`,
    update: null,
    ...extra,
  };
}

function job(state: AgentUpdateJob["state"], extra: Partial<AgentUpdateJob> = {}): AgentUpdateJob {
  return { state, command: "claude update", log: [], requestedAt: at, ...extra };
}

function status(...agents: AgentVersionInfo[]): AgentVersionsStatus {
  return { agents, checking: false };
}

function renderGroup(harness = "claude") {
  return render(
    <TooltipProvider>
      <AgentVersionGroup harness={harness} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  server.calls = [];
  server.fail = null;
  server.afterUpdate = null;
  server.status = status(agent("claude"), agent("codex", { installed: "0.159.1", latest: "0.159.1", state: "up-to-date", source: "npm" }));
  agentVersions.value = new Map();
  agentVersionsError.value = new Map();
  agentUpdateErrors.value = new Map();
  useEnvironments();
});
afterEach(() => {
  cleanup();
  resetEnvironmentsForTest();
});

describe("AgentVersionGroup", () => {
  it("asks a non-forced check on open; shows installed, newest and Update with its command", async () => {
    renderGroup();
    await screen.findByText("Installed 2.1.280");
    expect(server.calls).toContain("POST /agent-versions/check");
    expect(screen.getByText("2.1.293 available")).toBeTruthy();
    expect(screen.getByTestId("agent-version-status").dataset.state).toBe("behind");
    expect(screen.getByText("claude update")).toBeTruthy();
    expect(screen.getByText("Newest version from Claude Code latest channel", { exact: false })).toBeTruthy();
    const update = screen.getByRole("button", { name: "Update" });
    expect(update.className).toMatch(/bg-accent/);
  });

  it("Check Now forces a check", async () => {
    renderGroup();
    await screen.findByText("Installed 2.1.280");
    fireEvent.click(screen.getByRole("button", { name: "Check Now" }));
    await waitFor(() => expect(server.calls).toContain("POST /agent-versions/check?force=1"));
  });

  it("Update starts it: spinner and a collapsible log while it runs", async () => {
    server.afterUpdate = status(agent("claude", { update: job("running", { from: "2.1.280", log: ["$ claude update", "Downloading…"] }) }));
    renderGroup();
    fireEvent.click(await screen.findByRole("button", { name: "Update" }));
    await screen.findByTestId("agent-update-running");
    expect(server.calls).toContain("POST /agent-versions/claude/update");
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    // Collapsed by default while running; opens on click.
    fireEvent.click(screen.getByText("Log"));
    expect(screen.getByTestId("agent-update-log").textContent).toContain("Downloading…");
  });

  it("waiting for chats: says how many and can be cancelled", async () => {
    server.status = status(agent("claude", { update: job("waiting", { waitingFor: 2 }) }));
    renderGroup();
    await screen.findByText("Updates when 2 chats finish");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(server.calls).toContain("POST /agent-versions/claude/update/cancel"));
    expect(waitingText(1)).toBe("Updates when 1 chat finishes");
  });

  it("done: Updated to X and up to date", async () => {
    server.status = status(agent("claude", { installed: "2.1.293", state: "up-to-date", update: job("done", { from: "2.1.280", to: "2.1.293", log: ["ok"] }) }));
    renderGroup();
    await screen.findByText("Updated to 2.1.293");
    expect(screen.getByText("Up to date")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update" }).className).not.toMatch(/bg-accent/);
  });

  it("failed: the error, the log open, Try Again", async () => {
    server.status = status(agent("claude", { update: job("failed", { error: "`claude update` exited with code 1.", log: ["permission denied"] }) }));
    renderGroup();
    await screen.findByText("`claude update` exited with code 1.");
    expect(screen.getByTestId("agent-update-log").textContent).toContain("permission denied");
    expect(screen.getByRole("button", { name: "Try Again" })).toBeTruthy();
  });

  it("a refused update (409) says why", async () => {
    server.fail = { status: 409, message: "Claude Code is already updating." };
    renderGroup();
    fireEvent.click(await screen.findByRole("button", { name: "Update" }));
    expect((await screen.findByTestId("agent-update-action-error")).textContent).toBe("Claude Code is already updating.");
  });

  it("couldn't check / not installed", async () => {
    server.status = status(agent("claude", { state: "failed", latest: null, reason: "Couldn't reach Claude Code's release server (fetch failed)." }), agent("pi", { installed: null, latest: "0.71.2", state: "not-installed" }));
    const { unmount } = renderGroup();
    await screen.findByText("Couldn't check: Couldn't reach Claude Code's release server (fetch failed).");
    unmount();
    renderGroup("pi");
    await screen.findByText("Not installed");
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });

  it("another Mac: asks that Mac", async () => {
    const studio = fakeEnv({ id: "studio", name: "Studio" });
    const remoteCalls: string[] = [];
    vi.mocked(studio.request).mockImplementation((async (method: string, path: string) => {
      remoteCalls.push(`${method} ${path}`);
      return status(agent("claude", { installed: "2.1.100" }));
    }) as never);
    useEnvironments(studio);
    settingsEnvironmentId.value = "studio";
    renderGroup();
    await screen.findByText("Installed 2.1.100");
    expect(remoteCalls).toEqual(["GET /agent-versions", "POST /agent-versions/check"]);
    expect(server.calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(remoteCalls).toContain("POST /agent-versions/claude/update"));
  });
});

describe("agent versions state", () => {
  it("follows the local push and counts agents behind", () => {
    const behind = agentsBehind(null);
    expect(behind.value).toBe(0);
    act(() =>
      receiveAgentVersionsMessage({
        type: "batch",
        messages: [{ type: "agent_versions", status: status(agent("claude"), agent("pi"), agent("codex", { state: "up-to-date" })) }],
      }),
    );
    expect(behind.value).toBe(2);
    expect(agentsBehind(undefined)).toBe(behind);
  });
});
