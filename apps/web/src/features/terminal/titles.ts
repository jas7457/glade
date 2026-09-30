/**
 * Titles terminal shells set for themselves (OSC 0/2, e.g. zsh's `user@host:~` or the running
 * command), per terminal id (I-187). Shown after "Terminal" on the tab; not saved.
 */
import { signal } from "@preact/signals";

export const terminalTitles = signal<Readonly<Record<string, string>>>({});

export function setTerminalTitle(terminalId: string, title: string): void {
  if (terminalTitles.value[terminalId] === title) return;
  terminalTitles.value = { ...terminalTitles.value, [terminalId]: title };
}
