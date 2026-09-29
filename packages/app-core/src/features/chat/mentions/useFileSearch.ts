/**
 * Debounced file search for the `@` menu (I-044). Keeps the previous results while the next
 * query loads (no flicker) and ignores out-of-order responses.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { FileEntry } from "@glade/protocol";
import { searchFiles } from "@glade/app-core/lib/api-folder";
import { requestFor } from "@glade/app-core/state/env-api";
import { envIdOfProject } from "@glade/app-core/state/store";

const DEBOUNCE_MS = 60;

/**
 * `query === null` = no mention being typed (clears the results). `envId`: whose scratch folder
 * when `projectId` is null (I-123; a project's own environment otherwise).
 */
export function useFileSearch(projectId: string | null, query: string | null, envId?: string | null): FileEntry[] {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    if (query === null) {
      setEntries([]);
      return;
    }
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => searchFiles(projectId, query, undefined, requestFor(projectId ? envIdOfProject(projectId) : envId)))
        .then((res) => {
          if (seq.current === id) setEntries(res.entries);
        })
        .catch(() => {
          if (seq.current === id) setEntries([]);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [projectId, query, envId]);

  return query === null ? [] : entries;
}
