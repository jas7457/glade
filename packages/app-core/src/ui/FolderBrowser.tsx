/**
 * In-app folder picker (I-124), a macOS open-panel look-alike that works for any environment:
 * the caller passes that environment's `browse` / `mkdir` (GET /api/fs/browse, POST /api/fs/mkdir)
 * so the component itself never talks to a server.
 *
 *   <FolderBrowser browse={api.browse} mkdir={api.mkdir} initialPath="~"
 *                  recent={["/Users/me/code/app"]} onChoose={(path) => …} onCancel={…} />
 *
 * Parts: a path field with autocomplete of child folders, breadcrumbs, a shortcuts column (Home,
 * Volumes, recent folders), the folder list (git repos marked), "Show hidden", "New Folder".
 * Keys: ↑/↓ select, Enter or ⌘↓ opens, ⌘↑ goes to the parent, ⌘Enter chooses. "Choose" picks the
 * selected folder, or the open folder when nothing is selected.
 *
 * `memoryKey` (I-213; callers pass the environment id): the browser reopens in the last folder it
 * was in for that key on this device (`folder-memory.ts`), falling back quietly to the nearest
 * parent that still loads, else home. An explicit `initialPath` wins.
 */
import type { ComponentChildren } from "preact";
import type { FsBrowseEntry, FsBrowseResult } from "@glade/protocol";
import { ArrowUp, ChevronRight, Clock, Folder, FolderGit2, FolderPlus, HardDrive, House } from "lucide-preact";
import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import { cn } from "@glade/app-core/lib/cn";
import { openNearest, rememberedFolder, rememberFolder, type OpenAttempt } from "./folder-memory";
import { Button } from "./Button";
import { Checkbox } from "./Checkbox";
import { floatingSurfaceClass } from "./floating";
import { IconButton } from "./IconButton";
import { scrollRowIntoView } from "./list-scroll";
import { Spinner } from "./Spinner";
import { TextField } from "./TextField";

export interface FolderBrowserProps {
  /** List a folder's sub-folders (`~`/"" = the host user's home). */
  browse: (path: string, options: { hidden: boolean }) => Promise<FsBrowseResult>;
  /** Create a folder (absolute path); omit to hide "New Folder". */
  mkdir?: (path: string) => Promise<FsBrowseEntry>;
  /** Folder to open first (default: the remembered one for `memoryKey`, else `~`). */
  initialPath?: string;
  /**
   * Remember the last folder per device under this key (the environment id) and reopen there
   * (I-213). Ignored for the first folder when `initialPath` is given; still updated as you browse.
   */
  memoryKey?: string;
  /**
   * Touch (the iPhone, like Files): a tap opens a folder instead of selecting it, and Choose picks
   * the open folder. Default false (click selects, double-click opens).
   */
  openOnTap?: boolean;
  /** Recently used folders (e.g. other projects' folders), shown as shortcuts. */
  recent?: string[];
  /** Extra shortcut locations after Home (default: `/Volumes`). */
  locations?: string[];
  onChoose: (path: string) => void;
  /** Shows a Cancel button when given. */
  onCancel?: () => void;
  /** Label of the choose button (default "Choose"). */
  chooseLabel?: string;
  /** Label of the cancel button (default "Cancel"). */
  cancelLabel?: string;
  class?: string;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------------------------

/** Last segment of an absolute path ("/" for the root). */
export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : "/";
}

/** `path` joined with a child name. */
export function childPath(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

/**
 * Split what's typed in the path field into the folder to list and the name prefix to match:
 * `~/code/gl` → `{ dir: "~/code", prefix: "gl" }`, `/Users/` → `{ dir: "/Users", prefix: "" }`.
 * Returns null for text that isn't a path (relative).
 */
export function splitTyped(text: string): { dir: string; prefix: string } | null {
  if (text === "~") return { dir: "~", prefix: "" };
  if (!text.startsWith("/") && !text.startsWith("~/")) return null;
  const slash = text.lastIndexOf("/");
  const dir = text.slice(0, slash) || "/";
  return { dir, prefix: text.slice(slash + 1) };
}

/** Folders matching a typed prefix (case-insensitive); hidden ones only when the prefix starts with a dot. */
export function matchPrefix(entries: FsBrowseEntry[], prefix: string): FsBrowseEntry[] {
  const p = prefix.toLowerCase();
  return entries.filter((e) => (!e.hidden || p.startsWith(".")) && e.name.toLowerCase().startsWith(p));
}

export interface Crumb {
  label: string;
  path: string;
}

/**
 * Breadcrumbs of `path`, starting at the deepest known root containing it (home, `/Volumes`…),
 * otherwise at `/`. Folders above a root can't be browsed, so they aren't shown.
 */
export function crumbsFor(path: string, roots: Iterable<string>): Crumb[] {
  let start = "/";
  for (const root of roots) {
    if ((path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`)) && root.length > start.length) start = root;
  }
  const crumbs: Crumb[] = [{ label: baseName(start), path: start }];
  const rest = path.slice(start.length).split("/").filter(Boolean);
  let current = start;
  for (const name of rest) {
    current = childPath(current, name);
    crumbs.push({ label: name, path: current });
  }
  return crumbs;
}

// ---------------------------------------------------------------------------------------------

const rowClass = "flex h-[24px] items-center gap-2 rounded-[5px] px-2 select-none";

export function FolderBrowser({
  browse,
  mkdir,
  initialPath: initialPathProp,
  memoryKey,
  openOnTap = false,
  recent = [],
  locations = ["/Volumes"],
  onChoose,
  onCancel,
  chooseLabel = "Choose",
  cancelLabel = "Cancel",
  class: className,
}: FolderBrowserProps) {
  const [current, setCurrent] = useState<FsBrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  /** A navigation failed (403, network…); the previous listing stays. */
  const [navError, setNavError] = useState<string | null>(null);
  const [selected, setSelected] = useState(-1);
  const [hidden, setHidden] = useState(false);
  const [home, setHome] = useState<string | null>(null);
  /** Folders with no browsable parent (learned from results with `parent: null`). */
  const [roots, setRoots] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [newName, setNewName] = useState<string | null>(null);
  const [newError, setNewError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const newFieldRef = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const listId = useId();

  const learn = (result: FsBrowseResult) => {
    if (result.parent === null) setRoots((r) => (r.includes(result.path) ? r : [...r, result.path]));
  };

  /**
   * Open a folder; `select` = path of the entry to select afterwards. `quiet`: a folder that can't
   * be listed isn't shown or reported (the remembered-folder fallback tries its parent instead).
   */
  const open = async (
    path: string,
    options: { select?: string; hidden?: boolean; focusList?: boolean; quiet?: boolean } = {},
  ): Promise<OpenAttempt> => {
    const id = ++request.current;
    setLoading(true);
    if (!options.quiet) setNavError(null);
    try {
      const result = await browse(path, { hidden: options.hidden ?? hidden });
      if (id !== request.current) return "stale";
      if (options.quiet && result.error) return "failed";
      learn(result);
      if (memoryKey) rememberFolder(memoryKey, result.path);
      if (path === "~" || path === "") setHome(result.path);
      setCurrent(result);
      setDraft(result.path);
      setSelected(options.select ? result.entries.findIndex((e) => e.path === options.select) : -1);
      setNewName(null);
      if (options.focusList) listRef.current?.focus();
      return "ok";
    } catch (err) {
      if (id !== request.current) return "stale";
      if (!options.quiet) setNavError((err as Error).message);
      return "failed";
    } finally {
      if (id === request.current) setLoading(false);
    }
  };

  useEffect(() => {
    const remembered = initialPathProp === undefined && memoryKey ? rememberedFolder(memoryKey) : null;
    const initialPath = initialPathProp ?? remembered ?? "~";
    // Learn the home folder even when starting elsewhere (for the Home shortcut and crumbs).
    if (initialPath !== "~" && initialPath !== "") {
      browse("~", { hidden: false })
        .then((r) => {
          setHome(r.path);
          learn(r);
        })
        .catch(() => {});
    }
    if (remembered) void openNearest(remembered, (path) => open(path, { quiet: path !== "~" }));
    else void open(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- first open only
  }, []);

  const entries = current?.entries ?? [];

  // Focus the New Folder name field when it appears (autoFocus loses to dialog focus traps).
  const editingNew = newName !== null;
  useEffect(() => {
    if (!editingNew) return;
    const el = newFieldRef.current;
    el?.focus();
    el?.select();
  }, [editingNew]);

  // Keep the selected row visible.
  useEffect(() => {
    if (selected < 0) return;
    scrollRowIntoView(listRef.current, listRef.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`));
  }, [selected]);

  // Path field autocomplete ------------------------------------------------------------------
  const [suggestDir, setSuggestDir] = useState<{ dir: string; entries: FsBrowseEntry[] } | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIndex, setSuggestIndex] = useState(-1);
  const typed = suggestOpen ? splitTyped(draft) : null;

  useEffect(() => {
    if (!typed) return;
    const dir = typed.dir;
    if (suggestDir?.dir === dir) return;
    if (current && (dir === current.path || (dir === "~" && current.path === home))) {
      setSuggestDir({ dir, entries: current.entries });
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      browse(dir, { hidden: true })
        .then((r) => live && setSuggestDir({ dir, entries: r.entries }))
        .catch(() => live && setSuggestDir({ dir, entries: [] }));
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the typed folder
  }, [typed?.dir, current]);

  const suggestions = useMemo(
    () => (typed && suggestDir?.dir === typed.dir ? matchPrefix(suggestDir.entries, typed.prefix).slice(0, 50) : []),
    [typed?.dir, typed?.prefix, suggestDir],
  );
  const showSuggestions = suggestOpen && suggestions.length > 0;

  const complete = (entry: FsBrowseEntry) => {
    setDraft(`${entry.path}/`);
    setSuggestIndex(-1);
  };

  // Actions ----------------------------------------------------------------------------------
  const target = () => (selected >= 0 && entries[selected] ? entries[selected].path : current?.path ?? null);
  const choose = () => {
    const path = target();
    if (!path || loading) return;
    if (memoryKey) rememberFolder(memoryKey, path);
    onChoose(path);
  };
  const goUp = () => {
    if (current?.parent) void open(current.parent, { select: current.path, focusList: true });
  };
  const openSelected = () => {
    const entry = entries[selected];
    if (entry) void open(entry.path, { focusList: true });
  };
  const toggleHidden = (on: boolean) => {
    setHidden(on);
    if (current) void open(current.path, { hidden: on, select: entries[selected]?.path });
  };

  const startNewFolder = () => {
    setNewError(null);
    setNewName("untitled folder");
    setSelected(-1);
  };
  const createFolder = async () => {
    if (!mkdir || !current || newName === null || creating) return;
    const name = newName.trim();
    if (!name || name.includes("/")) {
      setNewError(name ? "Folder names can't contain “/”." : "Enter a folder name.");
      return;
    }
    setCreating(true);
    try {
      const entry = await mkdir(childPath(current.path, name));
      setNewName(null);
      await open(current.path, { select: entry.path, focusList: true });
    } catch (err) {
      setNewError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  // Keyboard ---------------------------------------------------------------------------------
  const onRootKeyDown = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      goUp();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      choose();
    }
  };

  const typeAhead = useRef({ text: "", at: 0 });
  const onListKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        openSelected();
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!entries.length) return;
      const next = e.key === "ArrowDown" ? Math.min(entries.length - 1, selected + 1) : selected < 0 ? entries.length - 1 : Math.max(0, selected - 1);
      setSelected(next);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      if (entries.length) setSelected(e.key === "Home" ? 0 : entries.length - 1);
    } else if (e.key === "Enter") {
      if (selected >= 0) {
        e.preventDefault();
        e.stopPropagation();
        openSelected();
      }
    } else if (e.key === "Backspace") {
      e.preventDefault();
      goUp();
    } else if (e.key.length === 1 && !e.altKey) {
      // Type to select, like Finder.
      const now = Date.now();
      const ta = typeAhead.current;
      ta.text = now - ta.at > 800 ? e.key.toLowerCase() : ta.text + e.key.toLowerCase();
      ta.at = now;
      const index = entries.findIndex((entry) => entry.name.toLowerCase().startsWith(ta.text));
      if (index >= 0) setSelected(index);
    }
  };

  const onFieldKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey) return; // ⌘↑ / ⌘Enter handled by the root
    if (showSuggestions && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const n = suggestions.length;
      setSuggestIndex((i) => (e.key === "ArrowDown" ? (i + 1) % n : i <= 0 ? n - 1 : i - 1));
    } else if (showSuggestions && e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      complete(suggestions[Math.max(0, suggestIndex)]!);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const pick = showSuggestions && suggestIndex >= 0 ? suggestions[suggestIndex]!.path : draft.trim();
      setSuggestOpen(false);
      if (pick) void open(pick, { focusList: true });
    } else if (e.key === "Escape") {
      if (showSuggestions) {
        e.preventDefault();
        e.stopPropagation();
        setSuggestOpen(false);
      } else if (current && draft !== current.path) {
        e.preventDefault();
        e.stopPropagation();
        setDraft(current.path);
      }
    }
  };

  // Render -----------------------------------------------------------------------------------
  const crumbs = current ? crumbsFor(current.path, roots) : [];
  const shortcuts = [
    { label: "Home", path: home ?? "~", icon: <House /> },
    ...locations.map((path) => ({ label: baseName(path), path, icon: <HardDrive /> })),
  ];
  const recentShown = recent.filter((p, i) => recent.indexOf(p) === i).slice(0, 8);
  const activeId = selected >= 0 ? `${listId}-${selected}` : undefined;

  return (
    <div
      class={cn("flex h-[360px] min-h-0 flex-col overflow-hidden rounded-[8px] bg-surface shadow-[0_0_0_0.5px_var(--pi-separator)]", className)}
      onKeyDown={onRootKeyDown}
    >
      {/* Toolbar: parent + breadcrumbs, then the path field */}
      <div class="flex shrink-0 flex-col gap-1.5 border-b border-separator px-2 pt-2 pb-2">
        <div class="flex min-w-0 items-center gap-1">
          <IconButton size="sm" label="Enclosing Folder (⌘↑)" disabled={!current?.parent || loading} onClick={goUp}>
            <ArrowUp />
          </IconButton>
          <nav aria-label="Path" class="flex min-w-0 flex-1 items-center overflow-hidden text-[0.92rem] select-none">
            {crumbs.map((c, i) => (
              <span key={c.path} class={cn("flex min-w-0 items-center", i < crumbs.length - 1 ? "shrink" : "shrink-0")}>
                {i > 0 && <ChevronRight size={12} class="mx-0.5 shrink-0 text-fg-subtle" />}
                <button
                  type="button"
                  class={cn(
                    "truncate rounded-[4px] px-1 py-px hover:bg-hover",
                    i === crumbs.length - 1 ? "font-medium text-fg" : "text-fg-muted",
                  )}
                  aria-current={i === crumbs.length - 1 ? "location" : undefined}
                  onClick={() => void open(c.path, { select: crumbs[i + 1]?.path })}
                >
                  {c.path === home ? "Home" : c.label}
                </button>
              </span>
            ))}
          </nav>
          {loading && <Spinner size={12} />}
        </div>
        <div class="relative">
          <TextField
            ref={fieldRef}
            size="sm"
            mono
            aria-label="Folder path"
            role="combobox"
            aria-expanded={showSuggestions}
            aria-controls={`${listId}-suggest`}
            aria-autocomplete="list"
            value={draft}
            placeholder="~/code"
            onInput={(e) => {
              setDraft(e.currentTarget.value);
              setSuggestOpen(true);
              setSuggestIndex(-1);
            }}
            onFocus={() => setSuggestOpen(false)}
            onBlur={() => setTimeout(() => setSuggestOpen(false), 120)}
            onKeyDown={onFieldKeyDown}
          />
          {showSuggestions && (
            <div
              id={`${listId}-suggest`}
              role="listbox"
              aria-label="Matching folders"
              class={cn(floatingSurfaceClass, "absolute top-full right-0 left-0 z-10 mt-1 max-h-[180px] overflow-y-auto rounded-[7px] p-1")}
            >
              {suggestions.map((s, i) => (
                <div
                  key={s.path}
                  role="option"
                  aria-selected={i === suggestIndex}
                  class={cn(rowClass, "font-mono text-[0.92rem]", i === suggestIndex ? "bg-accent text-accent-fg" : "hover:bg-hover")}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setSuggestOpen(false);
                    void open(s.path, { focusList: true });
                  }}
                >
                  <FolderIcon entry={s} active={i === suggestIndex} />
                  <span class="truncate">{s.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div class="flex min-h-0 flex-1">
        {/* Shortcuts */}
        <div class="flex w-[150px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-separator bg-sidebar px-1.5 py-2 text-sidebar-fg select-none">
          <ShortcutGroup title="Locations">
            {shortcuts.map((s) => (
              <Shortcut key={s.path} icon={s.icon} label={s.label} path={s.path} active={current?.path === s.path} onOpen={() => void open(s.path)} />
            ))}
          </ShortcutGroup>
          {recentShown.length > 0 && (
            <ShortcutGroup title="Recent">
              {recentShown.map((p) => (
                <Shortcut key={p} icon={<Clock />} label={baseName(p)} path={p} active={current?.path === p} onOpen={() => void open(p)} />
              ))}
            </ShortcutGroup>
          )}
        </div>

        {/* Folder list */}
        <div class="relative flex min-w-0 flex-1 flex-col">
          {navError && (
            <div role="alert" class="shrink-0 border-b border-separator bg-danger-tint px-3 py-1.5 text-[0.92rem] text-danger">
              {navError}
            </div>
          )}
          <div
            ref={listRef}
            role="listbox"
            tabIndex={0}
            aria-label={current ? `Folders in ${baseName(current.path)}` : "Folders"}
            aria-activedescendant={activeId}
            class="group/list min-h-0 flex-1 overflow-y-auto px-1.5 py-1 outline-none"
            onKeyDown={onListKeyDown}
          >
            {newName !== null && (
              <div class={cn(rowClass, "h-auto flex-col items-stretch gap-1 py-1")}>
                <div class="flex items-center gap-2">
                  <Folder size={16} class="shrink-0 fill-current/15 text-accent" />
                  <TextField
                    size="sm"
                    ref={newFieldRef}
                    aria-label="New folder name"
                    value={newName}
                    disabled={creating}
                    invalid={!!newError}
                    onInput={(e) => {
                      setNewName(e.currentTarget.value);
                      setNewError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.metaKey || e.ctrlKey) return;
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void createFolder();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setNewName(null);
                        listRef.current?.focus();
                      }
                    }}
                    onBlur={() => {
                      if (!creating && !newError) setNewName(null);
                    }}
                  />
                </div>
                {newError && (
                  <span role="alert" class="pl-6 text-[0.85rem] text-danger">
                    {newError}
                  </span>
                )}
              </div>
            )}
            {entries.map((entry, i) => (
              <div
                key={entry.path}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === selected}
                title={entry.path}
                class={cn(
                  rowClass,
                  i === selected ? "bg-selected group-focus/list:bg-accent group-focus/list:text-accent-fg" : "",
                  entry.hidden && "opacity-60",
                  loading && "opacity-50",
                )}
                onMouseDown={() => !openOnTap && setSelected(i)}
                onClick={() => (openOnTap ? void open(entry.path) : listRef.current?.focus())}
                onDblClick={() => void open(entry.path, { focusList: true })}
              >
                <FolderIcon entry={entry} active={i === selected} />
                <span class="min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.isGitRepo && (
                  <span
                    class={cn(
                      "shrink-0 rounded-[4px] px-1 text-[0.77rem] font-medium tracking-wide uppercase",
                      i === selected ? "text-fg-muted group-focus/list:text-accent-fg/80" : "text-fg-subtle",
                    )}
                  >
                    git
                  </span>
                )}
              </div>
            ))}
            {current && !entries.length && newName === null && (
              <div class="flex h-full items-center justify-center px-4 text-center text-[0.92rem] text-fg-subtle select-none">
                {current.error ?? "No folders"}
              </div>
            )}
            {!current && (
              <div class="flex h-full items-center justify-center">{loading ? <Spinner /> : null}</div>
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div class="flex shrink-0 items-center gap-2 border-t border-separator px-2 py-2">
        {mkdir && (
          <Button size="sm" disabled={!current || !!current.error || newName !== null} onClick={startNewFolder}>
            <FolderPlus size={13} />
            New Folder
          </Button>
        )}
        <label class="flex items-center gap-1.5 text-[0.92rem] text-fg-muted select-none">
          <Checkbox checked={hidden} onCheckedChange={toggleHidden} aria-label="Show hidden folders" />
          Show hidden
        </label>
        <span class="min-w-0 flex-1" />
        {current?.isGitRepo && selected < 0 && (
          <span class="flex shrink-0 items-center gap-1 text-[0.85rem] text-fg-muted">
            <FolderGit2 size={12} /> Git repository
          </span>
        )}
        {onCancel && (
          <Button size="sm" onClick={onCancel}>
            {cancelLabel}
          </Button>
        )}
        <Button size="sm" variant="primary" disabled={!current || loading} onClick={choose} title={target() ?? undefined}>
          {chooseLabel}
        </Button>
      </div>
    </div>
  );
}

function FolderIcon({ entry, active }: { entry: FsBrowseEntry; active: boolean }) {
  const Icon = entry.isGitRepo ? FolderGit2 : Folder;
  return (
    <Icon
      size={16}
      aria-hidden
      class={cn("shrink-0 fill-current/15 text-accent", active && "group-focus/list:text-accent-fg")}
    />
  );
}

function ShortcutGroup({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <div role="group" aria-label={title} class="flex flex-col">
      <div class="px-2 pb-0.5 text-[0.77rem] font-semibold text-sidebar-fg-muted">{title}</div>
      {children}
    </div>
  );
}

function Shortcut({ icon, label, path, active, onOpen }: { icon: ComponentChildren; label: string; path: string; active: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      title={path}
      aria-current={active || undefined}
      class={cn(
        "flex h-[24px] min-w-0 items-center gap-1.5 rounded-[5px] px-2 text-left text-[0.92rem] [&_svg]:size-3.5 [&_svg]:shrink-0",
        active ? "bg-selected text-sidebar-fg-strong" : "hover:bg-hover",
      )}
      onClick={onOpen}
    >
      <span class="text-accent">{icon}</span>
      <span class="truncate">{label}</span>
    </button>
  );
}
