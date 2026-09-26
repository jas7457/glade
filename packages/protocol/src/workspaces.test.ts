import { describe, expect, it } from "vitest";
import type { SessionSummary, Workspace } from "./api.js";
import { activeMainSessionId, firstMainSession, mainSessionsOf, rollupWorkspace, subagentSessionsOf } from "./workspaces.js";

function ws(over: Partial<Workspace> = {}): Workspace {
  return {
    id: "w1",
    projectId: null,
    title: "W",
    titleSource: "auto",
    cwd: "/tmp",
    pinned: false,
    createdAt: 1,
    lastActivityAt: 1,
    layout: null,
    ...over,
  };
}

function s(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    workspaceId: "w1",
    kind: "main",
    parentSessionId: null,
    agentName: null,
    title: id,
    titleSource: "auto",
    harness: "fake",
    sessionRef: null,
    unread: false,
    createdAt: 1,
    lastActivityAt: 1,
    model: null,
    thinkingLevel: null,
    running: false,
    pendingInputs: 0,
    status: "idle",
    ...over,
  };
}

const sessions = [
  s("b", { createdAt: 2 }),
  s("a", { createdAt: 1 }),
  s("sub", { kind: "subagent", parentSessionId: "a", createdAt: 3 }),
  s("other", { workspaceId: "w2", createdAt: 0 }),
];

describe("mainSessionsOf", () => {
  it("lists a workspace's main sessions by creation", () => {
    expect(mainSessionsOf(sessions, "w1").map((x) => x.id)).toEqual(["a", "b"]);
  });
  it("follows layout.mainOrder, appending unknown sessions and ignoring stale ids", () => {
    const three = [...sessions, s("c", { createdAt: 5 })];
    expect(mainSessionsOf(three, "w1", { mainOrder: ["gone", "b"] }).map((x) => x.id)).toEqual(["b", "a", "c"]);
  });
});

describe("activeMainSessionId / firstMainSession", () => {
  it("defaults to the first tab", () => {
    expect(activeMainSessionId(ws(), sessions)).toBe("a");
    expect(firstMainSession(sessions, "w1")?.id).toBe("a");
  });
  it("uses the saved active tab when it still exists", () => {
    expect(activeMainSessionId(ws({ layout: { activeMainSessionId: "b" } }), sessions)).toBe("b");
    expect(activeMainSessionId(ws({ layout: { activeMainSessionId: "sub" } }), sessions)).toBe("a");
    expect(activeMainSessionId(ws({ id: "none" }), sessions)).toBeNull();
  });
  it("finds sub-agents of a session", () => {
    expect(subagentSessionsOf(sessions, "a").map((x) => x.id)).toEqual(["sub"]);
  });
});

describe("rollupWorkspace", () => {
  it("takes the most urgent status and ORs the flags, sub-agents included", () => {
    const w = rollupWorkspace(ws(), [
      s("a", { status: "unread", unread: true }),
      s("b", { status: "working", running: true, lastRunFailed: true }),
      s("sub", { kind: "subagent", status: "blocked", pendingInputs: 2, interrupted: true }),
      s("x", { workspaceId: "w2", status: "blocked", pendingInputs: 5 }),
    ]);
    expect(w).toMatchObject({ status: "blocked", running: true, pendingInputs: 2, unread: true, lastRunFailed: true, interrupted: true });
  });
  it("is idle without sessions", () => {
    expect(rollupWorkspace(ws(), [])).toMatchObject({ status: "idle", running: false, unread: false, interrupted: false });
  });
});
