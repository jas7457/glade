/**
 * Minimal folder browser (like the column in an NSOpenPanel): breadcrumb + up button, a list of
 * sub-folders. Single click selects a folder, double click (or Return) opens it.
 */
import { useEffect, useState } from "preact/hooks";
import { ArrowUp, ChevronRight, Folder, House } from "lucide-preact";
import type { DirectoryListing } from "@pi-ui/protocol";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { IconButton, Spinner } from "@/ui";
import { pathSegments } from "./validation";

export interface FolderBrowserProps {
  /** Folder to show; `undefined` = home. */
  path: string | undefined;
  onNavigate: (path: string) => void;
  selected: string | null;
  onSelect: (path: string | null) => void;
  /** Reports the resolved current directory once loaded. */
  onLoaded?: (listing: DirectoryListing) => void;
}

export function FolderBrowser({ path, onNavigate, selected, onSelect, onLoaded }: FolderBrowserProps) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listDirectory(path)
      .then((l) => {
        if (cancelled) return;
        setListing(l);
        setError(null);
        onLoaded?.(l);
      })
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [path]);

  const segments = listing ? pathSegments(listing.path) : [];

  return (
    <div class="flex flex-col overflow-hidden rounded-[7px] bg-surface shadow-[0_0_0_0.5px_var(--pi-separator)]">
      <div class="flex h-8 items-center gap-1 border-b border-separator px-1.5">
        <IconButton size="sm" label="Enclosing Folder" disabled={!listing?.parent} onClick={() => listing?.parent && onNavigate(listing.parent)}>
          <ArrowUp />
        </IconButton>
        <IconButton size="sm" label="Home" onClick={() => onNavigate("~")}>
          <House />
        </IconButton>
        <div class="flex min-w-0 flex-1 items-center overflow-hidden text-[0.92rem] text-fg-muted" aria-label="Current folder">
          {segments.slice(-4).map((s, i, arr) => (
            <span key={s.path} class="flex min-w-0 items-center">
              <button type="button" class={cn("truncate rounded px-1 hover:bg-hover", i === arr.length - 1 && "font-medium text-fg")} onClick={() => onNavigate(s.path)}>
                {s.name}
              </button>
              {i < arr.length - 1 && <ChevronRight size={11} class="shrink-0 opacity-50" />}
            </span>
          ))}
        </div>
        {loading && <Spinner size={12} class="mr-1" />}
      </div>
      <div role="listbox" aria-label="Folders" class="h-[220px] overflow-y-auto p-1" onClick={(e) => e.target === e.currentTarget && onSelect(null)}>
        {error ? (
          <div class="p-3 text-danger">{error}</div>
        ) : listing && listing.entries.length === 0 && !loading ? (
          <div class="p-3 text-fg-subtle">No folders</div>
        ) : (
          listing?.entries.map((entry) => {
            const isSelected = entry.path === selected;
            return (
              <div
                key={entry.path}
                role="option"
                aria-selected={isSelected}
                tabIndex={0}
                onClick={() => onSelect(entry.path)}
                onDblClick={() => onNavigate(entry.path)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.preventDefault(), onNavigate(entry.path));
                }}
                class={cn(
                  "flex h-6 items-center gap-2 rounded-[4px] px-2 outline-none",
                  isSelected ? "bg-accent text-accent-fg" : "hover:bg-hover focus-visible:bg-hover",
                )}
              >
                <Folder size={14} class={cn("shrink-0", isSelected ? "text-accent-fg" : "text-accent")} />
                <span class="truncate">{entry.name}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
