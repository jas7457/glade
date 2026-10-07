/**
 * I-198: agent versions state: status texts, the behind count, and polling another Mac (no pushes
 * from there) only while a check or an update is in progress.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentVersionInfo, AgentVersionsStatus } from "@glade/protocol";
import { fakeEnv, resetEnvironmentsForTest, useEnvironments } from "@glade/app-core/test/env-fixtures";
import { agentVersions, agentVersionOf, countBehind, handleAgentVersions, isActive, versionStatusText } from "./agent-versions";

const info = (extra: Partial<AgentVersionInfo> = {}): AgentVersionInfo => ({
  harness: "claude",
  installed: "2.1.280",
  latest: "2.1.293",
  state: "behind",
  checkedAt: null,
  updateCommand: "claude update",
  update: null,
  ...extra,
});
const status = (...agents: AgentVersionInfo[]): AgentVersionsStatus => ({ agents, checking: false });

beforeEach(() => {
  agentVersions.value = new Map();
});
afterEach(() => {
  vi.useRealTimers();
  resetEnvironmentsForTest();
});

describe("agent versions state", () => {
  it("words the status line", () => {
    expect(versionStatusText(info())).toEqual({ text: "2.1.293 available", tone: "info" });
    expect(versionStatusText(info({ state: "up-to-date" }))).toEqual({ text: "Up to date", tone: "on" });
    expect(versionStatusText(info({ state: "not-installed" }))).toEqual({ text: "Not installed", tone: "off" });
    expect(versionStatusText(info({ state: "failed", reason: "Offline." }))).toEqual({ text: "Couldn't check: Offline.", tone: "error" });
    expect(versionStatusText(null, true)).toEqual({ text: "Checking…", tone: "off" });
    expect(versionStatusText(null)).toEqual({ text: "Not checked yet", tone: "off" });
  });

  it("counts behind agents and knows when something is in progress", () => {
    expect(countBehind(status(info(), info({ harness: "pi", state: "up-to-date" })))).toBe(1);
    expect(isActive(status(info()))).toBe(false);
    expect(isActive({ ...status(info()), checking: true })).toBe(true);
    expect(isActive(status(info({ update: { state: "waiting", command: "x", log: [], requestedAt: "" } })))).toBe(true);
    expect(isActive(status(info({ update: { state: "done", command: "x", log: [], requestedAt: "" } })))).toBe(false);
  });

  it("polls another Mac while an update runs there, then stops", async () => {
    vi.useFakeTimers();
    const studio = fakeEnv({ id: "studio" });
    const answers = [status(info({ update: { state: "running", command: "claude update", log: [], requestedAt: "" } })), status(info({ installed: "2.1.293", state: "up-to-date" }))];
    vi.mocked(studio.request).mockImplementation((async () => answers.shift() ?? status(info())) as never);
    useEnvironments(studio);
    handleAgentVersions(status(info({ update: { state: "running", command: "claude update", log: [], requestedAt: "" } })), "studio");
    await vi.advanceTimersByTimeAsync(1500);
    expect(studio.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(studio.request).toHaveBeenCalledTimes(2);
    expect(agentVersionOf("studio", "claude")?.installed).toBe("2.1.293");
    await vi.advanceTimersByTimeAsync(5000);
    expect(studio.request).toHaveBeenCalledTimes(2);
    // The local server pushes: never polled.
    handleAgentVersions({ ...status(info()), checking: true }, null);
    expect(agentVersionOf(null, "claude")?.installed).toBe("2.1.280");
  });
});
