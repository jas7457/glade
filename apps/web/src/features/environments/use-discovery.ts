/**
 * Glade hosts found on this device's tailnet (I-127; kept fresh by I-137), shared by Settings →
 * Remote Access → Connections and the "Connect to a Device" dialog.
 *
 * `GET /api/auth/discover` (local server only) runs when shown, every ~10 s while the window is
 * visible, when the window gets focus or becomes visible again, and on Refresh. Never two at
 * once: a refresh while one is running waits for that one. Hidden windows and unmounted views
 * don't poll.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { DiscoveredEnvironment } from "@glade/protocol";
import { hostAuth } from "@/lib/api-auth";
import { hasLocalEnvironment } from "@/state/env-registry";

export const DISCOVERY_POLL_MS = 10_000;

export interface DiscoveryPoller {
  /** Refresh now (joins a running request instead of starting another). */
  refresh(): Promise<void>;
  stop(): void;
}

export interface DiscoveryPollerOptions {
  discover: () => Promise<DiscoveredEnvironment[]>;
  /** Called with the reachable hosts after each successful request. */
  onResult: (found: DiscoveredEnvironment[]) => void;
  intervalMs?: number;
  /** Defaults to the real window / document (absent in non-DOM environments). */
  target?: { window?: Window; document?: Document };
}

/** The polling core (no Preact): first request at once, then timer + focus + visibility. */
export function startDiscoveryPoller({ discover, onResult, intervalMs = DISCOVERY_POLL_MS, target }: DiscoveryPollerOptions): DiscoveryPoller {
  const win = target?.window ?? (typeof window !== "undefined" ? window : undefined);
  const doc = target?.document ?? (typeof document !== "undefined" ? document : undefined);
  let stopped = false;
  let running: Promise<void> | null = null;
  const visible = () => !doc || doc.visibilityState !== "hidden";

  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = Promise.resolve()
      .then(() => discover())
      .then(
        (list) => {
          if (!stopped && Array.isArray(list)) onResult(list.filter((d) => d.reachable));
        },
        () => {
          /* keep the last list */
        },
      )
      .finally(() => {
        running = null;
      });
    return running;
  };
  const tick = () => {
    if (visible()) void refresh();
  };
  const onVisibility = () => {
    if (visible()) void refresh();
  };
  const timer = setInterval(tick, intervalMs);
  win?.addEventListener("focus", tick);
  doc?.addEventListener("visibilitychange", onVisibility);
  tick();
  return {
    refresh,
    stop() {
      stopped = true;
      clearInterval(timer);
      win?.removeEventListener("focus", tick);
      doc?.removeEventListener("visibilitychange", onVisibility);
    },
  };
}

export interface Discovery {
  /** Reachable Glade hosts on the tailnet (unfiltered: callers drop this device and known ones). */
  found: DiscoveredEnvironment[];
  /** A Refresh the user asked for is running (the automatic ones don't spin). */
  refreshing: boolean;
  refresh: () => void;
}

/** Discovery while `enabled` (e.g. the dialog is open) and this page has a local server. */
export function useDiscovery(enabled = true): Discovery {
  const [found, setFound] = useState<DiscoveredEnvironment[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const poller = useRef<DiscoveryPoller | null>(null);
  const on = enabled && hasLocalEnvironment.value;
  useEffect(() => {
    if (!on) return;
    const p = startDiscoveryPoller({ discover: () => hostAuth.discover(), onResult: setFound });
    poller.current = p;
    return () => {
      p.stop();
      if (poller.current === p) poller.current = null;
      setRefreshing(false);
    };
  }, [on]);
  const refresh = () => {
    const p = poller.current;
    if (!p) return;
    setRefreshing(true);
    void p.refresh().finally(() => {
      if (poller.current === p) setRefreshing(false);
    });
  };
  return { found: on ? found : [], refreshing, refresh };
}
