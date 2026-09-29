/**
 * Environments (I-123/I-124, design: docs/design/environments-and-store.md §3.3–3.4, §5).
 *
 * Every Glade server is an *environment*: one machine's files, agents, settings and chats, with a
 * permanent id that is separate from the addresses used to reach it. A project belongs to exactly
 * one environment (chosen at creation, never changed). A client (the Mac app's web view today,
 * the iPhone app later) connects to zero or more environments; it must not assume a local one.
 *
 *   GET /api/environment                 → EnvironmentInfo (no auth-sensitive data)
 *   PATCH /api/environment {name}        → EnvironmentInfo (rename this environment)
 *   GET /api/fs/browse?path=&hidden=1    → FsBrowseResult (directories only)
 *   POST /api/fs/mkdir {path}            → FsBrowseEntry (create a folder, for "New Folder")
 */
import type { BuildInfo } from "./version.js";

/** Things an environment can do; clients hide what's missing. */
export interface EnvironmentCapabilities {
  /** Can open a folder in an app (VS Code, Finder…) on the host machine (`POST …/open`). */
  openIn: boolean;
  /** Can reveal a file in the host's Finder. */
  reveal: boolean;
  /** Has a native folder picker on the host (osascript). Only useful when the host is this machine. */
  nativeFolderPicker: boolean;
  /** Serves `GET /api/fs/browse`. */
  browse: boolean;
  /** Can accept remote devices (I-125–I-127). False until those phases land. */
  remoteAccess: boolean;
}

export interface EnvironmentInfo {
  /** Permanent id (ULID), created on the server's first start, stored in the database. */
  id: string;
  /** Display name; defaults to the machine name (e.g. "Jason's Mac Studio"). Editable. */
  name: string;
  /** Glade version of the server. */
  version: string;
  /** Sync protocol version (matches `hello.protocol`). */
  protocol: number;
  /** `process.platform` of the host, e.g. "darwin". */
  platform: string;
  /** Host name of the machine (os.hostname()). */
  hostname: string;
  /** The host user's home folder (for "~" in the folder browser). */
  home: string;
  capabilities: EnvironmentCapabilities;
  /** The commit it was built from (I-149); absent on older servers and in identity-only answers. */
  build?: BuildInfo | null;
}

/** `PATCH /api/environment` body. `name` is trimmed; empty resets to the machine name. */
export interface UpdateEnvironmentRequest {
  name: string;
}

/** One directory in a browse listing. */
export interface FsBrowseEntry {
  name: string;
  /** Absolute path on the host. */
  path: string;
  /** Contains a `.git` entry (a repo root or worktree). */
  isGitRepo: boolean;
  /** Starts with a dot. */
  hidden: boolean;
}

export interface FsBrowseResult {
  /** The listed folder, absolute and normalized (`~` expanded). */
  path: string;
  /** Its parent, or null at the filesystem root / the top of the allowed area. */
  parent: string | null;
  /** Sub-directories, sorted by name (case-insensitive). Hidden ones only when asked. */
  entries: FsBrowseEntry[];
  /** The folder itself is a git repo. */
  isGitRepo: boolean;
  /** Set when the folder couldn't be read (permission denied, missing…); entries is then empty. */
  error?: string;
}
