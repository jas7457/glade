/**
 * REST client for the changes panel (I-097): git status, diffs, revert and commit of a
 * workspace's folder. Routes: apps/server/src/http/changes.ts.
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
