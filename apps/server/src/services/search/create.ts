/**
 * Wires the search service to the running harness: picks the session reader and fast model for
 * the harness id (pi: `harness/pi/session-reader.ts` + `harness/pi/one-shot.ts`). Other harnesses
 * register theirs here; without a reader only titles/summaries are searchable.
 *
 *   const search = createSearchService({ app: service, harnessId: harness.id, dataDir, scratchDir });
 */
import { piFastModel } from "../../harness/pi/one-shot.js";
import { piSessionReader } from "../../harness/pi/session-reader.js";
import { SearchService, type SearchAppSource } from "./search-service.js";

export interface CreateSearchServiceOptions {
  app: SearchAppSource;
  /** `AgentHarness.id` (e.g. "pi", "fake"). */
  harnessId: string;
  dataDir: string;
  /** Working directory for one-shot model runs. */
  scratchDir: string;
  log?: (msg: string) => void;
}

export function createSearchService({ app, harnessId, dataDir, scratchDir, log }: CreateSearchServiceOptions): SearchService {
  const isPi = harnessId === "pi";
  return new SearchService({
    app,
    dataDir,
    // Sessions are read by the harness that created them (session.harness).
    readers: { pi: piSessionReader },
    fastModel: isPi ? piFastModel({ piPath: () => app.getSettings().agent.piPath, cwd: scratchDir, log }) : undefined,
    log,
  });
}
