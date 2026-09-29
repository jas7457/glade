/**
 * REST client for the changes panel (I-097): git status, diffs, revert and commit of a
 * workspace's folder (or, for commits, a project's folder). Routes: apps/server/src/http/changes.ts.
 */
import type {
  CommitChangesResponse,
  CommitMessageResponse,
  GitChangesResponse,
  GitFileDiffResponse,
} from "@glade/protocol";
import { request } from "@glade/app-core/lib/api";
import { requestFor } from "@glade/app-core/state/env-api";
import { envIdOfProject, envIdOfWorkspace } from "@glade/app-core/state/store";

/** Requests go to the workspace's / project's environment (I-123). */
const ws = (workspaceId: string) => requestFor(envIdOfWorkspace(workspaceId)) ?? request;
const proj = (projectId: string) => requestFor(envIdOfProject(projectId)) ?? request;

const base = (workspaceId: string) => `/workspaces/${encodeURIComponent(workspaceId)}/changes`;

export const changesApi = {
  status: (workspaceId: string) => ws(workspaceId)<GitChangesResponse>("GET", base(workspaceId)),
  diff: (workspaceId: string, path: string) =>
    ws(workspaceId)<GitFileDiffResponse>("GET", `${base(workspaceId)}/diff?path=${encodeURIComponent(path)}`),
  revert: (workspaceId: string, paths: string[]) => ws(workspaceId)<GitChangesResponse>("POST", `${base(workspaceId)}/revert`, { paths }),
  commit: (workspaceId: string, message: string, paths?: string[]) =>
    ws(workspaceId)<CommitChangesResponse>("POST", `${base(workspaceId)}/commit`, paths ? { message, paths } : { message }),
  commitMessage: (workspaceId: string, paths?: string[]) =>
    ws(workspaceId)<CommitMessageResponse>("POST", `${base(workspaceId)}/commit-message`, paths ? { paths } : {}),
};

/** Commit in a project's own folder (I-105: the new-chat screen, which has no workspace yet). */
const projectBase = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/changes`;
export const projectChangesApi = {
  commit: (projectId: string, message: string, paths?: string[]) =>
    proj(projectId)<CommitChangesResponse>("POST", `${projectBase(projectId)}/commit`, paths ? { message, paths } : { message }),
  commitMessage: (projectId: string, paths?: string[]) =>
    proj(projectId)<CommitMessageResponse>("POST", `${projectBase(projectId)}/commit-message`, paths ? { paths } : {}),
};
