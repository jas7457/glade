/** Test data builders shared by web tests. */
import type { Project, SessionSummary, WorkspaceSummary } from "@glade/protocol";

/** A workspace (sidebar row). Pair it with {@link makeSession} for its conversation. */
export function makeWorkspace(overrides: Partial<WorkspaceSummary> & { id: string }): WorkspaceSummary {
  return {
    projectId: null,
    title: `Chat ${overrides.id}`,
    titleSource: "auto",
    cwd: "/tmp",
    pinned: false,
    createdAt: 0,
    lastActivityAt: 0,
    layout: null,
    status: "idle",
    running: false,
    pendingInputs: 0,
    unread: false,
    lastRunFailed: false,
    interrupted: false,
    ...overrides,
  };
}

/** A session; defaults to the main session of workspace `overrides.workspaceId ?? overrides.id`. */
export function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    workspaceId: overrides.id,
    kind: "main",
    parentSessionId: null,
    agentName: null,
    title: `Chat ${overrides.id}`,
    titleSource: "auto",
    harness: "fake",
    sessionRef: null,
    unread: false,
    createdAt: 0,
    lastActivityAt: 0,
    model: null,
    thinkingLevel: null,
    running: false,
    pendingInputs: 0,
    status: "idle",
    ...overrides,
  };
}

export function makeProject(overrides: Partial<Project> & { id: string }): Project {
  return {
    name: `Project ${overrides.id}`,
    path: `/code/${overrides.id}`,
    sortOrder: 0,
    createdAt: 0,
    lastActivityAt: 0,
    ...overrides,
  };
}
