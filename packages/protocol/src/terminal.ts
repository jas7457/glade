/**
 * Terminal tabs (I-187): a real login shell in a workspace's folder, on the Mac that runs the
 * workspace (a remote environment's chat gets that Mac's shell). Harness-neutral: terminals
 * belong to the workspace, not to an agent.
 *
 * The tab itself is saved in `WorkspaceLayout.terminals` (so it survives reloads and restarts);
 * the shell lives in the server that started it, only while that server runs. A tab whose shell
 * is gone (the app restarted) shows "Session ended" and can start a new one.
 *
 *   POST   /api/workspaces/:id/terminals/:terminalId/start  StartTerminalRequest → TerminalInfo
 *          (starts a shell, or returns the running one; restarts an exited one)
 *   GET    /api/workspaces/:id/terminals                     → TerminalInfo[] (this server's)
 *   DELETE /api/terminals/:terminalId                        → 204 (SIGHUP; closing the tab)
 *   WS     /ws/terminal/:terminalId                          TerminalClientMessage ⇄ TerminalServerMessage
 *          (same auth as `/ws`: the local owner, or a paired device with a one-time `?ticket=`)
 */

/** A terminal tab in `WorkspaceLayout.terminals`. */
export interface TerminalTab {
  /** Client-chosen id (also the shell's id on the server). */
  id: string;
  /** User-given title; else the shell's (OSC title) or "Terminal". */
  title?: string | null;
  createdAt: number;
}

export interface StartTerminalRequest {
  cols: number;
  rows: number;
}

/** A shell running (or exited) on this server. */
export interface TerminalInfo {
  id: string;
  workspaceId: string;
  /** Folder it started in. */
  cwd: string;
  /** The shell binary (`$SHELL`). */
  shell: string;
  pid: number;
  cols: number;
  rows: number;
  startedAt: number;
  /** Set once the shell exited (the tab offers Restart). */
  exit: TerminalExit | null;
}

export interface TerminalExit {
  code: number;
  signal: number | null;
}

/** Browser → server over `/ws/terminal/:id`. */
export type TerminalClientMessage = { type: "input"; data: string } | { type: "resize"; cols: number; rows: number };

/** Server → browser over `/ws/terminal/:id`. */
export type TerminalServerMessage =
  /** First message: the recent output (scrollback) and whether the shell already exited. */
  | { type: "snapshot"; data: string; info: TerminalInfo }
  | { type: "output"; data: string }
  | { type: "exit"; exit: TerminalExit }
  /** The shell was restarted (Restart after an exit). */
  | { type: "started"; info: TerminalInfo };

/** Close code when the server has no shell with that id (it restarted, or the tab was closed). */
export const TERMINAL_MISSING_CLOSE_CODE = 4404;

/** Limits shared by both sides. */
export const TERMINAL_LIMITS = {
  /** Scrollback kept on the server per shell (characters). */
  scrollbackChars: 1_000_000,
  minCols: 2,
  minRows: 1,
  maxCols: 1000,
  maxRows: 500,
} as const;

/** Valid terminal ids (client-chosen): short, URL-safe. */
export function isTerminalId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}
