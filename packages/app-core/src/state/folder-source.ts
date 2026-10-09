/**
 * Where a folder browser (ui/FolderBrowser) looks for folders (I-124): one environment's folder API.
 * Used by the Create Project dialog and by a group project's new-chat folder picker (I-213); a
 * caller can point it at any environment. {@link localFolderSource} is the server this app was
 * loaded from.
 */
import type { FsBrowseEntry, FsBrowseResult } from "@glade/protocol";
import { request, type RequestFn } from "@glade/app-core/lib/api";
import { isLocalEnvironment } from "./env-registry";
import { isThisMachine, requestFor } from "./env-api";

export interface ProjectFolderSource {
  /** `GET /api/fs/browse` of that environment. */
  browse: (path: string, options: { hidden: boolean }) => Promise<FsBrowseResult>;
  /** `POST /api/fs/mkdir` of that environment. */
  mkdir: (path: string) => Promise<FsBrowseEntry>;
  /** Offer "Choose in Finder…" (the desktop's native picker): only when the environment is this Mac. */
  nativePicker: boolean;
}

/** `send` is looked up per call (the local client can be swapped, e.g. in tests). */
function sourceVia(send: () => RequestFn, nativePicker: boolean): ProjectFolderSource {
  return {
    browse: (path, { hidden }) => {
      const q = new URLSearchParams({ path });
      if (hidden) q.set("hidden", "1");
      return send()<FsBrowseResult>("GET", `/fs/browse?${q}`);
    },
    mkdir: (path) => send()<FsBrowseEntry>("POST", "/fs/mkdir", { path }),
    nativePicker,
  };
}

export const localFolderSource: ProjectFolderSource = sourceVia(() => request, true);

/**
 * The folder source of any environment (I-123): its folder API, and "Choose in Finder…" only
 * when it is this machine. Untagged/`null` = the local environment.
 */
export function envFolderSource(envId: string | null | undefined): ProjectFolderSource {
  if (isLocalEnvironment(envId)) return { ...localFolderSource, nativePicker: isThisMachine(envId, "nativeFolderPicker") };
  const send = requestFor(envId) ?? request;
  return sourceVia(() => send, false);
}
