/**
 * Wires the search service to the installed harnesses (I-067): each harness with
 * `statSession` + `readSessionText` gets a session reader (sessions are read by the harness that
 * created them, `Session.harness`), and the default harness's `complete` is the small model for
 * summaries and the chat finder. Without a reader only titles/summaries are searchable; without
 * `complete` summaries are off and "Ask" falls back to keyword ranking.
 *
 *   const search = createSearchService({ app: service, harnesses, dataDir });
 */
import type { HarnessRegistry } from "../../harness/registry.js";
import type { AgentHarness } from "../../harness/types.js";
import { SearchService, type SearchAppSource } from "./search-service.js";
import type { SmallModel, SessionTextReader } from "./types.js";

export interface CreateSearchServiceOptions {
  app: SearchAppSource;
  harnesses: HarnessRegistry;
  dataDir: string;
  log?: (msg: string) => void;
}

/**
 * Session readers by harness id, for harnesses that can read their sessions without an agent.
 * Looked up live, so harnesses added later (ACP agents configured in Settings, I-119) are included.
 */
export function sessionReaders(harnesses: HarnessRegistry): Record<string, SessionTextReader> {
  const readerOf = (harness: AgentHarness | undefined): SessionTextReader | undefined => {
    if (!harness) return undefined;
    const { statSession, readSessionText } = harness;
    if (!statSession || !readSessionText) return undefined;
    return { stat: (ref) => statSession.call(harness, ref), read: (ref) => readSessionText.call(harness, ref) };
  };
  const ids = () => harnesses.list().filter((h) => readerOf(h)).map((h) => h.id);
  return new Proxy({} as Record<string, SessionTextReader>, {
    get: (_, id) => (typeof id === "string" ? readerOf(harnesses.get(id)) : undefined),
    has: (_, id) => typeof id === "string" && !!readerOf(harnesses.get(id)),
    ownKeys: () => ids(),
    getOwnPropertyDescriptor: (_, id) => {
      const reader = typeof id === "string" ? readerOf(harnesses.get(id)) : undefined;
      return reader ? { value: reader, enumerable: true, configurable: true, writable: false } : undefined;
    },
  });
}

/** The default harness's one-shot completion, or `undefined` when no harness has one. */
export function smallModel(harnesses: HarnessRegistry): SmallModel | undefined {
  if (!harnesses.list().some((h) => h.complete)) return undefined;
  return async ({ prompt, model, timeoutMs }) => {
    const harness = harnesses.default();
    return harness.complete ? harness.complete({ prompt, model, timeoutMs }) : null;
  };
}

export function createSearchService({ app, harnesses, dataDir, log }: CreateSearchServiceOptions): SearchService {
  return new SearchService({ app, dataDir, readers: sessionReaders(harnesses), smallModel: smallModel(harnesses), log });
}
