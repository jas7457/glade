/**
 * Closing a busy terminal (I-192): like Terminal.app, closing a tab whose shell runs a program
 * (not just its prompt) asks first: "Terminate “npm run dev”?". The server says what runs in the
 * foreground (`TerminalInfo.foreground`, asked when closing). Idle shells close without asking;
 * when the server can't be asked (offline, slow) the tab closes as before.
 *
 * Deleting a chat already asks; its dialog then also says which programs will be terminated
 * (`terminatingNote`).
 */
import type { TerminalInfo } from "@glade/protocol";
import { confirm, type ConfirmOptions } from "@glade/app-core/ui";
import { listTerminals } from "./terminal-api";

/** Don't hold a close up for longer than this asking the server. */
const ASK_TIMEOUT_MS = 3000;

/** The programs running in these shells (all of the list when `ids` is omitted). */
export function busyPrograms(infos: readonly TerminalInfo[], ids?: readonly string[]): string[] {
  return infos.filter((i) => (!ids || ids.includes(i.id)) && !i.exit && i.foreground).map((i) => i.foreground!);
}

/** Ask the workspace's server which of `ids` are busy; [] when it can't tell in time. */
export async function busyTerminalPrograms(workspaceId: string, ids?: readonly string[]): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ASK_TIMEOUT_MS);
  });
  try {
    const infos = await Promise.race([listTerminals(workspaceId), timeout]);
    return infos ? busyPrograms(infos, ids) : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

const quoted = (program: string) => `“${program.length > 60 ? `${program.slice(0, 59).trimEnd()}…` : program}”`;

/** The confirm for closing a terminal tab running `program`. */
export function terminateQuestion(program: string): ConfirmOptions {
  return {
    title: `Terminate ${quoted(program)}?`,
    message: "It's still running in this terminal. Closing the tab ends it.",
    confirmLabel: "Terminate",
    destructive: true,
  };
}

/** A terminal tab is about to close: true to go ahead (idle, or the user said Terminate). */
export async function confirmCloseTerminal(workspaceId: string, terminalId: string): Promise<boolean> {
  const [program] = await busyTerminalPrograms(workspaceId, [terminalId]);
  return program ? confirm(terminateQuestion(program)) : true;
}

/** A sentence for the delete-chat dialog about the programs its terminals run ("" for none). */
export function terminatingNote(programs: readonly string[]): string {
  if (programs.length === 0) return "";
  const names = programs.length <= 2 ? programs.map(quoted).join(" and ") : `${programs.slice(0, 2).map(quoted).join(", ")} and ${programs.length - 2} more`;
  return `${names} in its terminal${programs.length === 1 ? "" : "s"} will be terminated.`;
}
