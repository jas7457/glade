/** Test data builders shared by web tests. */
import type { ChatSummary, Project } from "@pi-ui/protocol";

export function makeChat(overrides: Partial<ChatSummary> & { id: string }): ChatSummary {
  return {
    projectId: null,
    title: `Chat ${overrides.id}`,
    titleSource: "auto",
    cwd: "/tmp",
    harness: "fake",
    sessionRef: null,
    pinned: false,
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
    pinned: false,
    createdAt: 0,
    lastActivityAt: 0,
    ...overrides,
  };
}
