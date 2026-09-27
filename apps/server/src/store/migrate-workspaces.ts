/**
 * I-035 migration: the flat chat index (`chats.json`) becomes workspaces + sessions
 * (`workspaces.json`). Every chat turns into one workspace with exactly one main session, and
 * both keep the chat's id, so old URLs (`/chats/:id`), the web's per-id caches and the pi
 * session file (`sessionRef`, untouched) all line up:
 *
 *   workspace.id = chat.id, session.id = chat.id, session.workspaceId = chat.id
 *
 * Workspace gets: projectId, title/titleSource, cwd, pinned/pinOrder, createdAt, lastActivityAt.
 * Session gets: title/titleSource, harness, sessionRef, unread, lastRunFailed, runInProgress,
 * interrupted, createdAt, lastActivityAt, model, thinkingLevel. Dropped: `archived` (unused
 * since archiving was removed).
 */
import type { ModelRef, Session, ThinkingLevel, Workspace } from "@glade/protocol";

/** A record of the pre-I-035 `chats.json`. */
export interface LegacyChat {
  id: string;
  projectId: string | null;
  title: string;
  titleSource: "auto" | "user";
  cwd: string;
  harness: string;
  sessionRef: string | null;
  pinned: boolean;
  unread: boolean;
  lastRunFailed?: boolean;
  pinOrder?: number;
  runInProgress?: boolean;
  interrupted?: boolean;
  createdAt: number;
  lastActivityAt: number;
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel | null;
}

export interface MigratedWorkspaces {
  workspaces: Workspace[];
  sessions: Session[];
}

export function migrateChats(chats: readonly LegacyChat[]): MigratedWorkspaces {
  const workspaces: Workspace[] = [];
  const sessions: Session[] = [];
  for (const c of chats) {
    const workspace: Workspace = {
      id: c.id,
      projectId: c.projectId ?? null,
      title: c.title,
      titleSource: c.titleSource ?? "auto",
      cwd: c.cwd,
      pinned: !!c.pinned,
      createdAt: c.createdAt,
      lastActivityAt: c.lastActivityAt ?? c.createdAt,
      layout: null,
    };
    if (c.pinned && typeof c.pinOrder === "number") workspace.pinOrder = c.pinOrder;
    workspaces.push(workspace);

    const session: Session = {
      id: c.id,
      workspaceId: c.id,
      kind: "main",
      parentSessionId: null,
      agentName: null,
      title: c.title,
      titleSource: c.titleSource ?? "auto",
      harness: c.harness,
      sessionRef: c.sessionRef ?? null,
      unread: !!c.unread,
      createdAt: c.createdAt,
      lastActivityAt: c.lastActivityAt ?? c.createdAt,
      model: c.model ?? null,
      thinkingLevel: c.thinkingLevel ?? null,
    };
    if (c.lastRunFailed !== undefined) session.lastRunFailed = c.lastRunFailed;
    if (c.runInProgress !== undefined) session.runInProgress = c.runInProgress;
    if (c.interrupted !== undefined) session.interrupted = c.interrupted;
    sessions.push(session);
  }
  return { workspaces, sessions };
}
