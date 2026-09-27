/**
 * Projects (folders chats run in): add, rename, manual order, "Open in <app>", delete with all
 * of their workspaces.
 */
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type { CreateProjectRequest, OpenTarget, Project, ProjectGitInfo, UpdateProjectRequest } from "@glade/protocol";
import { createOpenIn, isOpenTarget, OpenInError } from "../open-in.js";
import { checkoutBranch, createBranch } from "../project-git.js";
import { projectGitInfo } from "../worktrees.js";
import type { AppContext } from "./context.js";
import { HttpError } from "./errors.js";
import { dropProjectPrompts } from "./prompts.js";
import type { Records } from "./records.js";
import { sameIdSet, type Workspaces } from "./workspaces.js";

export class Projects {
  constructor(
    private readonly ctx: AppContext,
    private readonly records: Records,
    private readonly workspaces: Workspaces,
  ) {}

  /** Projects in their manual order (`sortOrder` ascending). */
  listProjects(): Project[] {
    return [...this.ctx.store.listProjects()].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  createProject(req: CreateProjectRequest): Project {
    if (!req.path?.trim()) throw new HttpError(400, "A folder path is required");
    const path = resolve(req.path.trim().replace(/^~(?=$|\/)/, homedir()));
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      /* missing */
    }
    if (!isDir) throw new HttpError(400, `Not a folder: ${path}`);
    const existing = this.ctx.store.listProjects().find((p) => p.path === path);
    if (existing) return existing;
    const now = Date.now();
    const orders = this.ctx.store.listProjects().map((p) => p.sortOrder);
    const project: Project = {
      id: randomUUID(),
      name: req.name?.trim() || basename(path) || path,
      path,
      // New projects go to the top of the manual order.
      sortOrder: orders.length ? Math.min(...orders) - 1 : 0,
      createdAt: now,
      lastActivityAt: now,
    };
    this.ctx.store.upsertProject(project);
    this.ctx.broadcast({ type: "project_upsert", project });
    return project;
  }

  updateProject(id: string, req: UpdateProjectRequest): Project {
    const project = this.records.requireProject(id);
    const next: Project = {
      ...project,
      ...(req.name !== undefined && req.name.trim() ? { name: req.name.trim() } : {}),
    };
    this.ctx.store.upsertProject(next);
    this.ctx.broadcast({ type: "project_upsert", project: next });
    return next;
  }

  /** Set the manual project order. `ids` must be exactly the current projects. */
  reorderProjects(ids: string[]): Project[] {
    const projects = this.ctx.store.listProjects();
    if (!sameIdSet(ids, projects.map((p) => p.id))) {
      throw new HttpError(400, "ids must list every project exactly once");
    }
    ids.forEach((id, sortOrder) => {
      const project = this.ctx.store.getProject(id)!;
      if (project.sortOrder === sortOrder) return;
      const next = { ...project, sortOrder };
      this.ctx.store.upsertProject(next);
      this.ctx.broadcast({ type: "project_upsert", project: next });
    });
    return this.listProjects();
  }

  /** Open a project's folder in another app (e.g. VS Code). */
  async openProject(id: string, app: unknown): Promise<void> {
    const project = this.records.requireProject(id);
    if (!isOpenTarget(app)) throw new HttpError(400, `Unknown app: ${String(app)}`);
    try {
      await (this.ctx.options.openIn ?? createOpenIn())(app satisfies OpenTarget, project.path);
    } catch (err) {
      if (err instanceof OpenInError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  /** Whether the project's folder is a git repository (worktree chats, I-096). */
  getProjectGit(id: string): Promise<ProjectGitInfo> {
    return projectGitInfo(this.records.requireProject(id).path);
  }

  /** Check out a branch in the project folder (I-105; refused while dirty or a local chat is working). */
  async checkoutProjectBranch(id: string, branch: string): Promise<ProjectGitInfo> {
    const project = this.records.requireProject(id);
    this.assertNoLocalRun(project.id, `switch to ${branch}`);
    return checkoutBranch(project.path, branch);
  }

  /** Create a branch from the project folder's HEAD, optionally checking it out (I-105). */
  async createProjectBranch(id: string, name: string, checkout: boolean): Promise<ProjectGitInfo> {
    const project = this.records.requireProject(id);
    if (checkout) this.assertNoLocalRun(project.id, `switch to ${name}`);
    return createBranch(project.path, name, checkout);
  }

  /** 409 while a chat of the project works in the project folder itself (not in a worktree). */
  private assertNoLocalRun(projectId: string, what: string): void {
    const busy = this.ctx.store
      .listWorkspaces()
      .filter((w) => w.projectId === projectId && !w.worktree)
      .map((w) => this.records.summarizeWorkspace(w))
      .filter((w) => w.running);
    if (busy.length === 0) return;
    const names = busy.map((w) => `"${w.title}"`).join(", ");
    throw new HttpError(409, `Can't ${what} while ${names} ${busy.length === 1 ? "is" : "are"} working in the project folder`);
  }

  /** Removes the project and all of its workspaces (including their session files). */
  async deleteProject(id: string): Promise<void> {
    this.records.requireProject(id);
    for (const workspace of this.ctx.store.listWorkspaces().filter((w) => w.projectId === id)) {
      await this.workspaces.deleteWorkspace(workspace.id);
    }
    this.ctx.store.removeProject(id);
    dropProjectPrompts(this.ctx, id); // its saved prompts (I-098) go with it
    this.ctx.broadcast({ type: "project_removed", projectId: id });
  }
}
