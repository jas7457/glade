/**
 * The xterm.js widget of a terminal tab (I-187): fit, web links and Unicode 11 widths, Glade's
 * theme and font (following light/dark changes), and the Mac keys:
 *
 * - ⌘K clears the terminal (in a browser the key never reaches the command palette; in the Mac
 *   app ⌘K is a menu item, which asks {@link clearFocusedTerminal} first).
 * - ⌘C copies the selection and ⌘V pastes (the browser's / Edit menu's copy and paste events,
 *   which xterm handles); ⌘A selects everything.
 * - ⌃` (new terminal) and ⌃Tab / ⌃⇧Tab (switch tabs) go to the app instead of the shell.
 *
 * Loaded lazily by the tab view (xterm is ~300 KB), and mocked in tests.
 */
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { openExternal } from "@glade/app-core/lib/desktop";
import { TERMINAL_FONT_FAMILY, terminalFontSize, terminalTheme } from "./theme";
import { setFocusedTerminal } from "./focus";

export interface XtermHost {
  readonly cols: number;
  readonly rows: number;
  write(data: string): void;
  reset(): void;
  clear(): void;
  focus(): void;
  /** Fit to the container; returns whether the size changed. */
  fit(): boolean;
  onData(listener: (data: string) => void): void;
  onResize(listener: (cols: number, rows: number) => void): void;
  onTitle(listener: (title: string) => void): void;
  dispose(): void;
}

export function createXterm(container: HTMLElement): XtermHost {
  const term = new Terminal({
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: terminalFontSize(),
    lineHeight: 1.15,
    theme: terminalTheme(container) as ITheme,
    cursorBlink: true,
    scrollback: 10_000,
    allowProposedApi: true, // Unicode 11 widths
    macOptionClickForcesSelection: true,
    rightClickSelectsWord: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((event, uri) => {
    event.preventDefault();
    void openExternal(uri);
  }));
  const unicode = new Unicode11Addon();
  term.loadAddon(unicode);
  term.unicode.activeVersion = "11";
  term.open(container);

  const handle = { clear: () => term.clear(), focus: () => term.focus() };
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const key = e.key.toLowerCase();
    if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && key === "k") {
      e.preventDefault();
      e.stopPropagation();
      term.clear();
      return false;
    }
    if (e.metaKey && !e.ctrlKey && !e.altKey && key === "a") {
      e.preventDefault();
      term.selectAll();
      return false;
    }
    // App shortcuts: let them bubble to the window instead of reaching the shell.
    if (e.ctrlKey && !e.metaKey && (e.key === "`" || e.code === "Backquote" || e.key === "Tab")) return false;
    return true;
  });
  const textarea = term.textarea;
  const onFocus = () => setFocusedTerminal(handle);
  const onBlur = () => setFocusedTerminal(null, handle);
  textarea?.addEventListener("focus", onFocus);
  textarea?.addEventListener("blur", onBlur);

  // Follow light/dark and font size changes.
  const observer = new MutationObserver(() => {
    term.options.theme = terminalTheme(container) as ITheme;
    const size = terminalFontSize();
    if (term.options.fontSize !== size) term.options.fontSize = size;
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });

  return {
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    write: (data) => term.write(data),
    reset: () => term.reset(),
    clear: () => term.clear(),
    focus: () => term.focus(),
    fit: () => {
      const before = `${term.cols}x${term.rows}`;
      try {
        fit.fit();
      } catch {
        return false; // not laid out yet
      }
      return `${term.cols}x${term.rows}` !== before;
    },
    onData: (listener) => void term.onData(listener),
    onResize: (listener) => void term.onResize(({ cols, rows }) => listener(cols, rows)),
    onTitle: (listener) => void term.onTitleChange(listener),
    dispose: () => {
      observer.disconnect();
      textarea?.removeEventListener("focus", onFocus);
      textarea?.removeEventListener("blur", onBlur);
      setFocusedTerminal(null, handle);
      term.dispose();
    },
  };
}
