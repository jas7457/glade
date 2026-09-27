/**
 * Workspaces (a chat with its tabs): create with the first session, rename (a single tab is
 * renamed with it), pin and reorder pins, layout, delete with all of its sessions.
 */
import { randomUUID } from "node:crypto";
import {
  quickTitle,
  type CreateWorkspaceRequest,
  type CreateWorkspaceResponse,
  type UpdateWorkspaceRequest,
  type Workspace,
  type WorkspaceDetail,
  type WorkspaceSummary,
} from "@glade/protocol";
import type { AppContext } from "./context.js";
import { HttpError } from "./errors.js";
import type { LeaseSync } from "./lease-sync.js";
import type { LivePool } from "./live-pool.js";
import type { Records } from "./records.js";
import type { Sessions } from "./sessions.js";

/** True when `ids` holds exactly the ids in `expected`, each once. */
export function sameIdSet(ids: string[], expected: string[]): boolean {
  const set = new Set(ids);
  return set.size === ids.length && ids.length === expected.length && expected.every((id) => set.has(id));
}

export class Workspaces {
  constructor(
    private readonly ctx: AppContext,
    private readonly records: Records,
    private readonly pool: LivePool,
    private readonly leaseSync: LeaseSync,
    private readonly sessions: Sessions,
  ) {}

  listWorkspaces(): WorkspaceSummary[] {
    return this.ctx.store.listWorkspaces().map((w) => this.records.summarizeWorkspace(w));
  }

  getWorkspaceDetail(id: string): WorkspaceDetail {
    const workspace = this.records.requireWorkspace(id);
    return { workspace: this.records.summarizeWorkspace(workspace), sessions: this.records.sessionsOf(id) };
  }

  /** A new workspace with its first main session (started, and prompted if a prompt is given). */
  async createWorkspace(req: CreateWorkspaceRequest): Promise<CreateWorkspaceResponse> {
    const project = req.projectId ? this.records.requireProject(req.projectId) : null;
    const now = Date.now();
    const workspace: Workspace = {
      id: randomUUID(),
      projectId: project?.id ?? null,
      title: req.prompt ? quickTitle(req.prompt) : "New chat",
      titleSource: "auto",
      cwd: project?.path ?? this.ctx.options.scratchDir,
      pinned: false,
      createdAt: now,
      lastActivityAt: now,
      layout: null,
    };
    this.ctx.store.upsertWorkspace(workspace);
    try {
      const session = await this.sessions.createSession(workspace.id, req);
      return { ...this.getWorkspaceDetail(workspace.id), session };
    } catch (err) {
      // Don't leave a broken, empty workspace behind.
      await this.deleteWorkspace(workspace.id).catch(() => {});
      throw err;
    }
  }

  async updateWorkspace(id: string, req: UpdateWorkspaceRequest): Promise<WorkspaceSummary> {
    const workspace = this.records.requireWorkspace(id);
    const next: Workspace = { ...workspace };
    if (req.title !== undefined) {
      const title = req.title.trim();
      if (!title) throw new HttpError(400, "Title cannot be empty");
      next.title = title;
      next.titleSource = "user";
      // With a single tab, the tab and the workspace are the same thing to the user.
      const main = this.ctx.store.listSessions(id).filter((s) => s.kind === "main");
      if (main.length === 1) await this.records.renameSession(main[0]!, title);
    }
    if (req.pinned === true && !workspace.pinned) {
      // Newly pinned workspaces go to the top of their list's pinned group.
      const orders = this.pinnedWorkspaces(workspace.projectId).map((w) => w.pinOrder ?? 0);
      next.pinned = true;
      next.pinOrder = orders.length ? Math.min(...orders) - 1 : 0;
    } else if (req.pinned === false) {
      next.pinned = false;
      delete next.pinOrder;
    }
    if (req.layout !== undefined) next.layout = req.layout;
    return this.records.saveWorkspace(next);
  }

  /** Pinned workspaces of one list (a project, or standalone = null), in pin order. */
  private pinnedWorkspaces(projectId: string | null): Workspace[] {
    return this.ctx.store
      .listWorkspaces()
      .filter((w) => w.pinned && w.projectId === projectId)
      .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0));
  }

  /** Reorder the pinned workspaces of one list. `ids` must be exactly that list's pinned workspaces. */
  reorderPinnedWorkspaces(projectId: string | null, ids: string[]): WorkspaceSummary[] {
    if (projectId !== null) this.records.requireProject(projectId);
    if (!sameIdSet(ids, this.pinnedWorkspaces(projectId).map((w) => w.id))) {
      throw new HttpError(400, "ids must list every pinned workspace of that list exactly once");
    }
    ids.forEach((id, pinOrder) => {
      const workspace = this.ctx.store.getWorkspace(id)!;
      if (workspace.pinOrder !== pinOrder) this.records.saveWorkspace({ ...workspace, pinOrder });
    });
    return this.pinnedWorkspaces(projectId).map((w) => this.records.summarizeWorkspace(w));
  }

  /** Delete a workspace, stopping its agents and permanently deleting all of its session files. */
  async deleteWorkspace(id: string): Promise<void> {
    this.records.requireWorkspace(id);
    await this.leaseSync.takeLeases(this.ctx.store.listSessions(id));
    for (const session of this.ctx.store.listSessions(id)) {
      await this.pool.disposeSession(session);
      this.records.forgetAgent(session.id);
    }
    this.ctx.agents.removeWhere((r) => r.workspaceId === id); // incl. closed ones whose tab is gone
    this.ctx.store.removeWorkspace(id);
    this.ctx.broadcast({ type: "workspace_removed", workspaceId: id });
  }
}
