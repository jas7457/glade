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
import { request } from "@/lib/api";

const base = (workspaceId: string) => `/workspaces/${encodeURIComponent(workspaceId)}/changes`;

export const changesApi = {
  status: (workspaceId: string) => request<GitChangesResponse>("GET", base(workspaceId)),
  diff: (workspaceId: string, path: string) =>
    request<GitFileDiffResponse>("GET", `${base(workspaceId)}/diff?path=${encodeURIComponent(path)}`),
  revert: (workspaceId: string, paths: string[]) => request<GitChangesResponse>("POST", `${base(workspaceId)}/revert`, { paths }),
  commit: (workspaceId: string, message: string, paths?: string[]) =>
    request<CommitChangesResponse>("POST", `${base(workspaceId)}/commit`, paths ? { message, paths } : { message }),
  commitMessage: (workspaceId: string, paths?: string[]) =>
    request<CommitMessageResponse>("POST", `${base(workspaceId)}/commit-message`, paths ? { paths } : {}),
};

/** Commit in a project's own folder (I-105: the new-chat screen, which has no workspace yet). */
const projectBase = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/changes`;
export const projectChangesApi = {
  commit: (projectId: string, message: string, paths?: string[]) =>
    request<CommitChangesResponse>("POST", `${projectBase(projectId)}/commit`, paths ? { message, paths } : { message }),
  commitMessage: (projectId: string, paths?: string[]) =>
    request<CommitMessageResponse>("POST", `${projectBase(projectId)}/commit-message`, paths ? { paths } : {}),
};
