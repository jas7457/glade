/**
 * A terminal tab's content (I-187): xterm.js attached to the workspace's shell on its Mac. The
 * terminal fills the pane and refits when the pane resizes; the shell's size follows.
 *
 * States (see terminal-session.ts): live; exited ("[Process exited with code N]" in the
 * terminal, plus a Restart bar); ended (the shell is gone, e.g. Glade restarted: "Session ended"
 * with New Session); error (can't reach the host).
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { RotateCw, SquareTerminal } from "lucide-preact";
import { Button } from "@glade/app-core/ui";
import { startTerminal, terminalSocketUrl } from "./terminal-api";
import { TerminalSession } from "./terminal-session";
import { setTerminalTitle } from "./titles";
import type { XtermHost } from "./xterm-host";

export interface TerminalViewProps {
  workspaceId: string;
  terminalId: string;
  /** Focus the terminal once it's ready (the tab was just picked). */
  autoFocus?: boolean;
}

export function TerminalView({ workspaceId, terminalId, autoFocus = true }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const xtermRef = useRef<XtermHost | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let disposed = false;
    let cleanup = () => {};
    void import("./xterm-host").then(
      ({ createXterm }) => {
        if (disposed) return;
        const xterm = createXterm(el);
        xtermRef.current = xterm;
        xterm.fit();
        const s = new TerminalSession({
          screen: xterm,
          socketUrl: () => terminalSocketUrl(workspaceId, terminalId),
          start: (size) => startTerminal(workspaceId, terminalId, size),
        });
        xterm.onData((data) => s.input(data));
        xterm.onResize((cols, rows) => s.resize(cols, rows));
        xterm.onTitle((title) => setTerminalTitle(terminalId, title));
        // Refit when the pane changes size (window, split, sidebar), at most once per frame.
        let frame = 0;
        const observer = new ResizeObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => xterm.fit());
        });
        observer.observe(el);
        s.connect();
        setSession(s);
        if (autoFocus) xterm.focus();
        cleanup = () => {
          cancelAnimationFrame(frame);
          observer.disconnect();
          s.dispose();
          xterm.dispose();
          xtermRef.current = null;
        };
      },
      (err: Error) => !disposed && setLoadError(err.message),
    );
    return () => {
      disposed = true;
      cleanup();
    };
    // autoFocus only matters on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, terminalId]);

  const status = session?.status.value ?? "connecting";
  // The shell's last title (e.g. "exit 3") is stale once it's gone.
  useEffect(() => {
    if (status === "exited" || status === "ended") setTerminalTitle(terminalId, "");
  }, [status, terminalId]);
  const exit = session?.exit.value ?? null;
  const error = loadError ?? session?.error.value ?? null;
  const restart = () => {
    void session?.restart().then(() => xtermRef.current?.focus());
  };

  return (
    <div class="relative flex h-full min-h-0 flex-col bg-window" data-terminal-view={terminalId}>
      <div class="min-h-0 flex-1 pt-1.5 pb-1 pl-2.5" onMouseDown={() => status !== "ended" && xtermRef.current?.focus()}>
        <div ref={hostRef} class="h-full w-full" data-terminal />
      </div>
      {status === "exited" && exit && (
        <div class="flex shrink-0 items-center gap-2 border-t-[0.5px] border-separator px-3 py-1.5 text-fg-muted">
          <span class="flex-1">Process exited with code {exit.code}</span>
          <Button size="sm" onClick={restart}>
            <RotateCw class="size-3" />
            Restart
          </Button>
        </div>
      )}
      {(status === "ended" || status === "error" || loadError) && (
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-window text-center">
          <SquareTerminal class="size-6 text-fg-subtle" />
          <div class="font-medium text-fg">{status === "ended" ? "Session ended" : "Can't open the terminal"}</div>
          <div class="max-w-80 text-fg-muted">
            {status === "ended" ? "This shell isn't running any more (Glade was restarted). Start a new one in the same folder." : error}
          </div>
          {!loadError && (
            <Button size="sm" variant="primary" onClick={status === "ended" ? restart : () => session?.connect()}>
              {status === "ended" ? "New Session" : "Try Again"}
            </Button>
          )}
        </div>
      )}
      {status !== "ended" && error && !loadError && status !== "error" && (
        <div class="absolute right-3 bottom-10 rounded-control bg-danger-tint px-2 py-1 text-danger">{error}</div>
      )}
    </div>
  );
}
