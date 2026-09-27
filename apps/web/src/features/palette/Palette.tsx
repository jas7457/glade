/**
 * The ⌘K command palette: jump to chats and projects and run app actions by name. Commands come
 * from the app registry (`app/commands.tsx`), ranking from `match.ts`, the panel from
 * `ui/CommandPalette`. Mounted once in the app layout; open state is `paletteOpen` (state/ui).
 *
 * Also searches inside chats (I-045: a "Messages" group with snippets, from `GET /api/search`)
 * and has an "Ask" mode (I-046): type `?` first or press Tab, describe the chat, Return. A fast
 * model picks the best matches; a confident answer opens the chat directly.
 *
 * Opening a message hit (or an Ask result found by keyword) jumps to the matched message
 * (I-093, `features/chat/jump-to-message.ts`); title/summary hits open the chat as usual.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { AskResponse, MessageAnchor, SearchHit } from "@glade/protocol";
import { CommandPalette, Spinner, type CommandPaletteSection } from "@/ui";
import { COMMAND_GROUPS, isAvailable, type Command, type CommandContext, type CommandPrompt, buildCommands } from "@/app/commands";
import { chatPath } from "@/app/routes";
import { requestJump } from "@/features/chat/jump-to-message";
import { askChats, searchChats } from "@/lib/api-search";
import { workspacesById } from "@/state/store";
import { paletteOpen } from "@/state/ui";
import { rankItems } from "./match";
import { ASK_ENTRY_ID, askSections, withSearchSections } from "./search-sections";

/** Rows per group when the query is empty (Actions without a query are the common ones). */
const EMPTY_LIMIT = { Chats: 8, Projects: 5 };
/** Message search waits for a pause in typing. */
const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_MIN_CHARS = 2;

export function paletteSections(commands: readonly Command[], query: string): CommandPaletteSection[] {
  return rankItems(commands.filter(isAvailable), query, { groupOrder: COMMAND_GROUPS, emptyLimit: EMPTY_LIMIT, limit: 8 }).map(({ group, items }) => ({
    title: group,
    items: items.map(({ item, indices }) => ({
      id: item.id,
      title: item.title,
      subtitle: item.subtitle,
      icon: item.icon,
      shortcut: item.shortcut,
      highlights: indices,
    })),
  }));
}

export interface PaletteProps {
  context: Omit<CommandContext, "togglePalette">;
}

export function Palette({ context }: PaletteProps) {
  // Mounted only while open, so every opening starts with an empty query.
  return paletteOpen.value ? <PalettePanel context={context} /> : null;
}

/** Full-text hits for `query` (debounced; stale responses are dropped). */
function useMessageSearch(query: string): SearchHit[] {
  const [hits, setHits] = useState<SearchHit[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < SEARCH_MIN_CHARS) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => searchChats(q, 12))
        .then((res) => !cancelled && setHits(res.hits))
        .catch(() => !cancelled && setHits([]));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);
  return hits;
}

type AskState = { status: "idle" } | { status: "loading" } | { status: "done"; result: AskResponse } | { status: "error"; message: string };

function PalettePanel({ context }: PaletteProps) {
  const [query, setQuery] = useState("");
  const [prompt, setPrompt] = useState<CommandPrompt | null>(null);
  const [askMode, setAskMode] = useState(false);
  const [ask, setAsk] = useState<AskState>({ status: "idle" });
  const askSeq = useRef(0);
  const hits = useMessageSearch(prompt || askMode ? "" : query);

  const setOpen = (next: boolean) => {
    paletteOpen.value = next;
  };

  const openChat = (workspaceId: string, sessionId: string, kind: "main" | "subagent", message?: MessageAnchor) => {
    const workspace = workspacesById.value.get(workspaceId);
    if (!workspace) return;
    setOpen(false);
    if (message) requestJump(sessionId, message);
    context.navigate(chatPath(workspace, kind === "main" ? sessionId : null));
  };

  const submitAsk = (text: string) => {
    const q = text.trim();
    if (!q) return;
    const seq = ++askSeq.current;
    setAsk({ status: "loading" });
    askChats(q)
      .then((result) => {
        if (seq !== askSeq.current) return;
        const best = result.matches[0];
        if (result.confident && best && workspacesById.value.has(best.workspaceId)) {
          openChat(best.workspaceId, best.sessionId, best.sessionKind, best.message);
          return;
        }
        setAsk({ status: "done", result });
      })
      .catch((err: Error) => seq === askSeq.current && setAsk({ status: "error", message: err.message }));
  };

  const enterAskMode = (text: string, submit = false) => {
    setAskMode(true);
    setQuery(text);
    setAsk({ status: "idle" });
    if (submit) submitAsk(text);
  };

  const leaveAskMode = () => {
    askSeq.current++;
    setAskMode(false);
    setAsk({ status: "idle" });
  };

  const onQueryChange = (value: string) => {
    if (!prompt && !askMode && value.startsWith("?")) return enterAskMode(value.slice(1).trimStart());
    setQuery(value);
    if (askMode && ask.status !== "idle") {
      askSeq.current++;
      setAsk({ status: "idle" });
    }
  };

  const onInputKeyDown = (e: KeyboardEvent): boolean => {
    if (prompt) return false;
    if (e.key === "Tab" && !e.shiftKey && !askMode) {
      e.preventDefault();
      enterAskMode(query.trim());
      return true;
    }
    if (e.key === "Backspace" && askMode && query === "") {
      e.preventDefault();
      leaveAskMode();
      return true;
    }
    return false;
  };

  const commands = buildCommands({ ...context, togglePalette: () => setOpen(!paletteOpen.value) });
  const run = (id: string) => {
    if (id === ASK_ENTRY_ID) return enterAskMode(query.trim(), true);
    if (id.startsWith("msg:")) {
      const hit = hits.find((h) => `msg:${h.sessionId}` === id);
      return hit && openChat(hit.workspaceId, hit.sessionId, hit.sessionKind, hit.message);
    }
    if (id.startsWith("ask:") && ask.status === "done") {
      const match = ask.result.matches.find((m) => `ask:${m.sessionId}` === id);
      return match && openChat(match.workspaceId, match.sessionId, match.sessionKind, match.message);
    }
    const command = commands.find((c) => c.id === id);
    if (!command) return;
    const next = command.prompt?.();
    if (next) {
      setPrompt(next);
      setQuery(next.initial);
      return;
    }
    setOpen(false);
    // After the palette has closed and handed focus back, so dialogs opened by the command
    // (e.g. the delete confirmation) own the focus.
    setTimeout(() => void command.run(), 0);
  };

  if (askMode) {
    return (
      <CommandPalette
        open
        onOpenChange={setOpen}
        query={query}
        onQueryChange={onQueryChange}
        sections={ask.status === "done" ? askSections(ask.result.matches) : []}
        onRun={run}
        placeholder="Describe the chat you're looking for…"
        badge="Ask"
        onSubmit={submitAsk}
        onInputKeyDown={onInputKeyDown}
        status={<AskStatus state={ask} hasQuery={!!query.trim()} />}
      />
    );
  }

  return (
    <CommandPalette
      open
      onOpenChange={setOpen}
      query={query}
      onQueryChange={onQueryChange}
      sections={prompt ? [] : withSearchSections(paletteSections(commands, query), hits, query)}
      onRun={run}
      placeholder={prompt ? prompt.placeholder : "Search chats, messages and actions… (? to ask)"}
      badge={prompt?.title}
      onInputKeyDown={onInputKeyDown}
      onSubmit={
        prompt
          ? (value) => {
              void prompt.submit(value);
              setOpen(false);
            }
          : undefined
      }
    />
  );
}

function AskStatus({ state, hasQuery }: { state: AskState; hasQuery: boolean }) {
  switch (state.status) {
    case "loading":
      return (
        <span class="inline-flex items-center gap-2">
          <Spinner /> Looking through your chats…
        </span>
      );
    case "error":
      return <>Couldn't search: {state.message}</>;
    case "done":
      return <>No matching chat found.</>;
    default:
      return <>{hasQuery ? "Press Return to find the chat." : "Describe a chat, e.g. “where we added the new button”."} ⌫ goes back.</>;
  }
}
