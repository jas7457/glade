/**
 * Wires the search service to the store and the installed harnesses: every session's text comes
 * from the store (I-121; sessions not imported yet are filled in by the background import), and
 * the default harness's `complete` is the small model for summaries and the chat finder (I-067).
 * Without `complete` summaries are off and "Ask" falls back to keyword ranking.
 *
 *   const search = createSearchService({ app: service, harnesses, store });
 */
import type { HarnessRegistry } from "../../harness/registry.js";
import type { Store } from "../../store/store.js";
import { SearchService, type SearchAppSource } from "./search-service.js";
import type { SessionTextReader, SessionTextSource, SmallModel, SummaryStore } from "./types.js";

export interface CreateSearchServiceOptions {
  app: SearchAppSource;
  harnesses: HarnessRegistry;
  store: Store;
  log?: (msg: string) => void;
}

/** Session text from the store: the transcript version, and the messages' plain text. */
export function storeTexts(store: Store): SessionTextSource {
  return {
    version: (session) => {
      if (store.isClosed) return null;
      const info = store.transcriptInfo(session.id);
      return info ? String(info.version) : null;
    },
    read: (session) => (store.isClosed ? null : { name: null, messages: store.sessionText(session.id) }),
  };
}

export function storeSummaries(store: Store): SummaryStore {
  return {
    get: (id) => (store.isClosed ? null : store.getSummary(id)),
    list: () => (store.isClosed ? new Map() : store.listSummaries()),
    set: (id, summary) => !store.isClosed && store.setSummary(id, summary),
    remove: (ids) => !store.isClosed && store.removeSummaries(ids),
    enabledAt: (now) => (store.isClosed ? now : store.summariesEnabledAt(now)),
  };
}

/** Text read straight from harness readers keyed by harness id (tests of the readers). */
export function readerTexts(readers: Readonly<Record<string, SessionTextReader>>): SessionTextSource {
  return {
    async version(session) {
      const reader = readers[session.harness];
      if (!reader || !session.sessionRef) return null;
      const stat = await reader.stat(session.sessionRef);
      return stat ? `${session.sessionRef}:${stat.mtimeMs}:${stat.size}` : null;
    },
    async read(session) {
      const reader = readers[session.harness];
      return reader && session.sessionRef ? reader.read(session.sessionRef) : null;
    },
  };
}

/** The default harness's one-shot completion, or `undefined` when no harness has one. */
export function smallModel(harnesses: HarnessRegistry): SmallModel | undefined {
  if (!harnesses.list().some((h) => h.complete)) return undefined;
  return async ({ prompt, model, timeoutMs }) => {
    const harness = harnesses.default();
    return harness.complete ? harness.complete({ prompt, model, timeoutMs }) : null;
  };
}

export function createSearchService({ app, harnesses, store, log }: CreateSearchServiceOptions): SearchService {
  return new SearchService({ app, texts: storeTexts(store), summaries: storeSummaries(store), smallModel: smallModel(harnesses), log });
}
