/**
 * Which terminal has keyboard focus (I-187), so app-level commands can act on it: ⌘K arrives as
 * the Mac app's menu action "command-palette" (the menu owns the key there) and clears the
 * focused terminal instead of opening the palette. Kept free of xterm so the shortcut code can
 * import it without loading the terminal.
 */

export interface FocusedTerminal {
  clear(): void;
  focus(): void;
}

let focused: FocusedTerminal | null = null;

/** Set the focused terminal; `null` with `owner` clears it only if `owner` still has focus. */
export function setFocusedTerminal(terminal: FocusedTerminal | null, owner?: FocusedTerminal): void {
  if (terminal) focused = terminal;
  else if (!owner || focused === owner) focused = null;
}

/** ⌘K in a terminal: clear it. Returns whether a terminal had focus. */
export function clearFocusedTerminal(): boolean {
  if (!focused) return false;
  focused.clear();
  return true;
}
