/**
 * Searching inside chats from the iPhone chat list (I-167), like the desktop ⌘K palette:
 * "In conversations" full-text hits (`GET /api/search`) and "Ask" (`POST /api/search/ask`, a fast
 * model picks the chats that match a description), from every connected Mac.
 *
 * Macs that are down or connecting are skipped, and one that fails is left out quietly (Ask only
 * reports an error when every Mac failed). Requests can't be aborted (`RequestFn` has no signal),
 * so a stale one is cancelled by dropping its answer: the debounce timer is cleared and a sequence
 * number / `cancelled` flag ignores responses for an older query.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { AskMatch, MessageAnchor, SearchHit } from "@glade/protocol";
import { askChats, searchChats } from "@glade/app-core/lib/api-search";
import { connections, type EnvHandle } from "@glade/app-core/state/env-registry";
import { remoteStateOf } from "@glade/app-core/state/remote-status";
import { workspacesById } from "@glade/app-core/state/store";

/** Full-text search waits for a pause in typing. */
export const SEARCH_DEBOUNCE_MS = 250;
/** Shorter queries only filter titles. */
export const SEARCH_MIN_CHARS = 2;
/** Hits asked per Mac, and shown in total. */
const HITS_PER_MAC = 12;
const HITS_SHOWN = 15;
/** Picks asked per Mac. */
const ASK_LIMIT = 3;

/** Something found inside a chat, and where to open it. */
export interface SessionTarget {
  envId: string;
  workspaceId: string;
  sessionId: string;
  sessionKind: "main" | "subagent";
  /** The matched message, to jump to (I-093). */
  message?: MessageAnchor;
}

export type ContentHit = SearchHit & { envId: string };
export type AskPick = AskMatch & { envId: string };

/** The Macs to ask: the local one (never on the iPhone) and every connected remote. */
export function searchableConnections(): EnvHandle[] {
  return connections.value.filter((c) => c.isLocal || remoteStateOf(c.id) === "connected");
}

/**
 * Pure: merge each Mac's hits (best first within a Mac; scores don't compare across Macs, so the
 * lists are interleaved), without title-only hits (the title list already shows those), chats
 * the list doesn't know, or a session twice.
 */
export function mergeHits(perMac: ReadonlyArray<readonly ContentHit[]>, known: (workspaceId: string) => boolean, limit = HITS_SHOWN): ContentHit[] {
  const lists = perMac.map((hits) => hits.filter((h) => h.matchedIn !== "title" && known(h.workspaceId)));
  const out: ContentHit[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < limit && lists.some((l) => i < l.length); i++) {
    for (const list of lists) {
      const hit = list[i];
      if (!hit || seen.has(hit.sessionId)) continue;
      seen.add(hit.sessionId);
      out.push(hit);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export type ContentSearch = { status: "idle"; hits: ContentHit[] } | { status: "loading"; hits: ContentHit[] } | { status: "done"; hits: ContentHit[] };

/** Full-text hits for `query` from every connected Mac, after a pause in typing. */
export function useContentSearch(query: string): ContentSearch {
  const [state, setState] = useState<ContentSearch>({ status: "idle", hits: [] });
  const q = query.trim();
  useEffect(() => {
    if (q.length < SEARCH_MIN_CHARS) {
      setState({ status: "idle", hits: [] });
      return;
    }
    let cancelled = false;
    // Keep the previous hits on screen while the new ones load (no flicker per keystroke).
    setState((s) => ({ status: "loading", hits: s.hits }));
    const timer = setTimeout(() => {
      const macs = searchableConnections();
      Promise.all(
        macs.map((c) =>
          searchChats(q, HITS_PER_MAC, c.request)
            .then((r) => (r?.hits ?? []).map((h) => ({ ...h, envId: c.id })))
            .catch(() => [] as ContentHit[]),
        ),
      ).then((perMac) => {
        if (cancelled) return;
        const known = workspacesById.value;
        setState({ status: "done", hits: mergeHits(perMac, (id) => known.has(id)) });
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);
  return state;
}

export type AskState = { status: "idle" } | { status: "loading" } | { status: "done"; picks: AskPick[]; /** No Mac had a model to ask: keyword matches only. */ keywordOnly: boolean } | { status: "error"; message: string };

/**
 * Pure: every Mac's picks (each best first) interleaved, without chats the list doesn't know or a
 * session twice. `null` when every Mac failed.
 */
export function mergePicks(perMac: ReadonlyArray<readonly AskPick[] | null>, known: (workspaceId: string) => boolean): AskPick[] | null {
  if (perMac.length > 0 && perMac.every((p) => p === null)) return null;
  const lists = perMac.map((p) => (p ?? []).filter((m) => known(m.workspaceId)));
  const out: AskPick[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const m = list[i];
      if (!m || seen.has(m.sessionId)) continue;
      seen.add(m.sessionId);
      out.push(m);
    }
  }
  return out;
}

/** Ask every connected Mac to find the chats matching `query`; resets when the query changes. */
export function useAsk(query: string): { state: AskState; run: () => void } {
  const [state, setState] = useState<AskState>({ status: "idle" });
  const seq = useRef(0);
  const q = query.trim();
  useEffect(() => {
    seq.current++;
    setState({ status: "idle" });
  }, [q]);
  const run = () => {
    if (!q) return;
    const mine = ++seq.current;
    const macs = searchableConnections();
    if (macs.length === 0) {
      setState({ status: "error", message: "No Mac is connected." });
      return;
    }
    setState({ status: "loading" });
    let firstError = "";
    let modelAnswered = false;
    Promise.all(
      macs.map((c) =>
        askChats(q, ASK_LIMIT, c.request)
          .then((r) => {
            if (r?.model) modelAnswered = true;
            return (r?.matches ?? []).map((m) => ({ ...m, envId: c.id }));
          })
          .catch((err: unknown) => {
            firstError ||= err instanceof Error ? err.message : String(err);
            return null;
          }),
      ),
    ).then((perMac) => {
      if (mine !== seq.current) return;
      const known = workspacesById.value;
      const picks = mergePicks(perMac, (id) => known.has(id));
      setState(picks ? { status: "done", picks, keywordOnly: !modelAnswered } : { status: "error", message: firstError || "The Mac didn't answer." });
    });
  };
  return { state, run };
}
