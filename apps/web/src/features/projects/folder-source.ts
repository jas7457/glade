/**
 * Where the Create Project dialog looks for folders (I-124): one environment's folder API.
 * The dialog takes a {@link ProjectFolderSource} as input, so a caller can point it at any
 * environment; {@link localFolderSource} is the server this web app was loaded from.
 */
import type { FsBrowseEntry, FsBrowseResult } from "@glade/protocol";
import { request } from "@glade/app-core/lib/api";
import { isLocalEnvironment } from "@glade/app-core/state/env-registry";
import { isThisMachine, requestFor } from "@glade/app-core/state/env-api";

export interface ProjectFolderSource {
  /** `GET /api/fs/browse` of that environment. */
  browse: (path: string, options: { hidden: boolean }) => Promise<FsBrowseResult>;
  /** `POST /api/fs/mkdir` of that environment. */
  mkdir: (path: string) => Promise<FsBrowseEntry>;
  /** Offer "Choose in Finder…" (lib/native `pickFolder`): only when the environment is this Mac. */
  nativePicker: boolean;
}

export const localFolderSource: ProjectFolderSource = {
  browse: (path, { hidden }) => {
    const q = new URLSearchParams({ path });
    if (hidden) q.set("hidden", "1");
    return request<FsBrowseResult>("GET", `/fs/browse?${q}`);
  },
  mkdir: (path) => request<FsBrowseEntry>("POST", "/fs/mkdir", { path }),
  nativePicker: true,
};

/**
 * The folder source of any environment (I-123): its folder API, and "Choose in Finder…" only
 * when it is this machine. Untagged/`null` = the local environment.
 */
export function envFolderSource(envId: string | null | undefined): ProjectFolderSource {
  if (isLocalEnvironment(envId)) return { ...localFolderSource, nativePicker: isThisMachine(envId, "nativeFolderPicker") };
  const send = requestFor(envId) ?? request;
  return {
    browse: (path, { hidden }) => {
      const q = new URLSearchParams({ path });
      if (hidden) q.set("hidden", "1");
      return send<FsBrowseResult>("GET", `/fs/browse?${q}`);
    },
    mkdir: (path) => send<FsBrowseEntry>("POST", "/fs/mkdir", { path }),
    nativePicker: false,
  };
}
