/**
 * Palette sections for chat search (I-045) and the chat finder (I-046): message hits with
 * snippets, "Ask" results with the model's reason, and the "Find a chat…" entry row. Pure
 * helpers so the grouping is unit-testable; `Palette.tsx` owns the requests.
 */
import { MessageSquare, MessageSquareText, Sparkles } from "lucide-preact";
import type { AskMatch, SearchHit } from "@glade/protocol";
import { TextHighlight, type CommandPaletteSection } from "@glade/app-core/ui";

/** Row ids: `msg:<sessionId>`, `ask:<sessionId>`, and the entry row. */
export const ASK_ENTRY_ID = "ask-mode";
export const MESSAGES_GROUP = "Messages";
export const ASK_GROUP = "Ask";
export const ASK_RESULTS_GROUP = "Best Matches";

/** Queries this long (in words) also offer "Find a chat…" (natural-language requests). */
export const ASK_ENTRY_MIN_WORDS = 3;

/** Message hits worth showing: title-only hits are already covered by the Chats group. */
export function messageHits(hits: readonly SearchHit[], limit = 6): SearchHit[] {
  return hits.filter((h) => h.matchedIn !== "title").slice(0, limit);
}

/** Insert the "Messages" section right after "Chats" (or at the end) and the Ask entry last. */
export function withSearchSections(sections: CommandPaletteSection[], hits: readonly SearchHit[], query: string): CommandPaletteSection[] {
  const out = [...sections];
  const shown = messageHits(hits);
  if (shown.length) {
    const messages: CommandPaletteSection = {
      title: MESSAGES_GROUP,
      items: shown.map((hit) => ({
        id: `msg:${hit.sessionId}`,
        title: hit.title || hit.workspaceTitle || "Untitled",
        subtitle: hit.project ?? undefined,
        icon: <MessageSquareText />,
        detail: <TextHighlight text={hit.snippet.text} ranges={hit.snippet.highlights} />,
      })),
    };
    const chats = out.findIndex((s) => s.title === "Chats");
    out.splice(chats === -1 ? out.length : chats + 1, 0, messages);
  }
  if (query.trim().split(/\s+/).length >= ASK_ENTRY_MIN_WORDS) {
    out.push({
      title: ASK_GROUP,
      items: [{ id: ASK_ENTRY_ID, title: `Find a chat: “${query.trim()}”`, icon: <Sparkles />, shortcut: "tab" }],
    });
  }
  return out;
}

export function askSections(matches: readonly AskMatch[]): CommandPaletteSection[] {
  if (!matches.length) return [];
  return [
    {
      title: ASK_RESULTS_GROUP,
      items: matches.map((m) => ({
        id: `ask:${m.sessionId}`,
        title: m.title || "Untitled",
        subtitle: m.project ?? undefined,
        icon: <MessageSquare />,
        detail: m.reason || m.summary || undefined,
      })),
    },
  ];
}
