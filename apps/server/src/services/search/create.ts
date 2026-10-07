/**
 * Wires the search service to the store and the installed harnesses: every session's text comes
 * from the store (I-121; sessions not imported yet are filled in by the background import), and
 * the quick-tasks agent's `complete` (I-198; else the default harness's) is the small model for
 * summaries and the chat finder (I-067). Without any `complete` summaries are off and "Ask" falls
 * back to keyword ranking.
 *
 *   const search = createSearchService({ app: service, harnesses, store });
 */
import { defaultSettings, type ModelRef, type Settings } from "@glade/protocol";
import type { HarnessRegistry } from "../../harness/registry.js";
import type { Store } from "../../store/store.js";
import { quickCompletionHarness, quickCompletionRunner } from "../app/quick-tasks.js";
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

/**
 * The quick-tasks agent's one-shot completion (I-198), else the default harness's; `undefined`
 * when no harness has one.
 */
export function smallModel(harnesses: HarnessRegistry, settings: () => Settings = defaultSettings): SmallModel | undefined {
  if (!harnesses.list().some((h) => h.complete)) return undefined;
  return async ({ prompt, model, timeoutMs }) => {
    const harness = quickCompletionHarness(settings(), harnesses);
    return harness?.complete ? harness.complete({ prompt, model, timeoutMs }) : null;
  };
}

/** The model {@link smallModel} runs with: the quick-tasks model, else Haiku when listed, else the default. */
export function smallModelRef(harnesses: HarnessRegistry, settings: () => Settings): () => Promise<ModelRef | null> {
  return async () => (await quickCompletionRunner(settings(), harnesses))?.model ?? null;
}

export function createSearchService({ app, harnesses, store, log }: CreateSearchServiceOptions): SearchService {
  const settings = () => store.getSettings();
  return new SearchService({
    app,
    texts: storeTexts(store),
    summaries: storeSummaries(store),
    smallModel: smallModel(harnesses, settings),
    smallModelRef: smallModelRef(harnesses, settings),
    log,
  });
}
