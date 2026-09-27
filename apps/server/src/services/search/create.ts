/**
 * Wires the search service to the installed harnesses (I-067): each harness with
 * `statSession` + `readSessionText` gets a session reader (sessions are read by the harness that
 * created them, `Session.harness`), and the default harness's `complete` is the fast model for
 * summaries and the chat finder. Without a reader only titles/summaries are searchable; without
 * `complete` summaries are off and "Ask" falls back to keyword ranking.
 *
 *   const search = createSearchService({ app: service, harnesses, dataDir });
 */
import type { HarnessRegistry } from "../../harness/registry.js";
import { SearchService, type SearchAppSource } from "./search-service.js";
import type { FastModel, SessionTextReader } from "./types.js";

export interface CreateSearchServiceOptions {
  app: SearchAppSource;
  harnesses: HarnessRegistry;
  dataDir: string;
  log?: (msg: string) => void;
}

/** Session readers by harness id, for harnesses that can read their sessions without an agent. */
export function sessionReaders(harnesses: HarnessRegistry): Record<string, SessionTextReader> {
  const readers: Record<string, SessionTextReader> = {};
  for (const harness of harnesses.list()) {
    const { statSession, readSessionText } = harness;
    if (!statSession || !readSessionText) continue;
    readers[harness.id] = { stat: (ref) => statSession.call(harness, ref), read: (ref) => readSessionText.call(harness, ref) };
  }
  return readers;
}

/** The default harness's one-shot completion, or `undefined` when no harness has one. */
export function fastModel(harnesses: HarnessRegistry): FastModel | undefined {
  if (!harnesses.list().some((h) => h.complete)) return undefined;
  return async ({ prompt, model, timeoutMs }) => {
    const harness = harnesses.default();
    return harness.complete ? harness.complete({ prompt, model, timeoutMs }) : null;
  };
}

export function createSearchService({ app, harnesses, dataDir, log }: CreateSearchServiceOptions): SearchService {
  return new SearchService({ app, dataDir, readers: sessionReaders(harnesses), fastModel: fastModel(harnesses), log });
}
