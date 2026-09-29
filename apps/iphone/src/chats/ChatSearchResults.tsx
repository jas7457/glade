/**
 * The chat list's results from inside chats (I-167), below the title matches while searching:
 * "In Conversations" (full-text hits with their snippet) and the "✦ Ask" row, which asks every
 * connected Mac's fast model for the chats matching the query and lists its picks with the
 * one-line reason. The Mac's name is shown when several are connected. Requests: `chat-search.ts`.
 */
import { MessageSquareText, Sparkles } from "lucide-preact";
import { formatRelativeTime } from "@glade/app-core/features/sidebar/time";
import { connectionFor } from "@glade/app-core/state/env-registry";
import { Spinner, TextHighlight } from "@glade/app-core/ui";
import { DeviceMarker } from "~/ui/phone-extra";
import type { AskPick, AskState, ContentHit, ContentSearch, SessionTarget } from "./chat-search";

export interface ChatSearchResultsProps {
  query: string;
  content: ContentSearch;
  ask: AskState;
  onAsk: () => void;
  onOpen: (target: SessionTarget) => void;
  /** Show which Mac each result is on. */
  multi: boolean;
}

const sectionTitle = "flex items-center gap-2 px-4 pb-1.5 text-[13px] text-fg-muted uppercase";
const list = "overflow-hidden rounded-xl bg-cell [&>*+*]:border-t [&>*+*]:border-separator";

function targetOf(r: ContentHit | AskPick): SessionTarget {
  return { envId: r.envId, workspaceId: r.workspaceId, sessionId: r.sessionId, sessionKind: r.sessionKind, ...(r.message ? { message: r.message } : {}) };
}

export function ChatSearchResults({ query, content, ask, onAsk, onOpen, multi }: ChatSearchResultsProps) {
  const q = query.trim();
  const searching = content.status === "loading";
  return (
    <>
      {(content.hits.length > 0 || searching) && (
        <section class="mx-4 mb-5" aria-label="In Conversations" aria-busy={searching || undefined}>
          <h2 class={sectionTitle}>
            In Conversations
            {searching && content.hits.length > 0 && <Spinner size={11} />}
          </h2>
          <div role="list" class={list}>
            {content.hits.length === 0 ? (
              <div role="listitem" class="flex min-h-11 items-center gap-2 px-4 py-2.5 text-[15px] text-fg-muted">
                <Spinner size={14} /> Searching conversations…
              </div>
            ) : (
              content.hits.map((hit) => (
                <ResultRow
                  key={`${hit.envId}:${hit.sessionId}`}
                  kind="hit"
                  title={hit.title || hit.workspaceTitle || "Untitled"}
                  envId={multi ? hit.envId : null}
                  trailing={formatRelativeTime(hit.updatedAt)}
                  detail={<TextHighlight text={hit.snippet.text} ranges={hit.snippet.highlights} />}
                  onClick={() => onOpen(targetOf(hit))}
                  sessionId={hit.sessionId}
                />
              ))
            )}
          </div>
        </section>
      )}
      <section class="mx-4 mb-5" aria-label="Ask" aria-busy={ask.status === "loading" || undefined}>
        <div role="list" class={list}>
          <div role="listitem">
            <button
              type="button"
              data-ask
              disabled={ask.status === "loading"}
              onClick={onAsk}
              class="flex min-h-11 w-full items-center gap-2 px-4 py-2.5 text-left select-none active:bg-hover"
            >
              <Sparkles size={17} class="shrink-0 text-accent" aria-hidden />
              <span class="min-w-0 flex-1 truncate">
                <span class="text-accent">Ask:</span> “{q}”
              </span>
              {ask.status === "loading" && <Spinner size={14} />}
            </button>
          </div>
          {ask.status === "loading" && <Note>Looking through your chats…</Note>}
          {ask.status === "error" && <Note>Couldn't ask: {ask.message}</Note>}
          {ask.status === "done" && ask.picks.length === 0 && <Note>No matching chat found.</Note>}
          {ask.status === "done" &&
            ask.picks.map((pick) => (
              <ResultRow
                key={`${pick.envId}:${pick.sessionId}`}
                kind="pick"
                title={pick.title || "Untitled"}
                envId={multi ? pick.envId : null}
                trailing={pick.project ?? undefined}
                detail={pick.reason || pick.summary || undefined}
                onClick={() => onOpen(targetOf(pick))}
                sessionId={pick.sessionId}
              />
            ))}
        </div>
        {ask.status === "done" && ask.keywordOnly && <p class="px-4 pt-1.5 text-[13px] text-fg-muted">Matched by keywords: no fast model is set up on your Mac.</p>}
        {ask.status === "idle" && <p class="px-4 pt-1.5 text-[13px] text-fg-muted">A fast model on your Mac finds the chats that match what you describe.</p>}
      </section>
    </>
  );
}

function Note({ children }: { children: preact.ComponentChildren }) {
  return (
    <div role="listitem" class="px-4 py-2.5 text-[15px] text-fg-muted">
      {children}
    </div>
  );
}

function ResultRow({
  kind,
  title,
  envId,
  trailing,
  detail,
  onClick,
  sessionId,
}: {
  kind: "hit" | "pick";
  title: string;
  envId: string | null;
  trailing?: string;
  detail?: preact.ComponentChildren;
  onClick: () => void;
  sessionId: string;
}) {
  return (
    <div role="listitem">
      <button
        type="button"
        data-search-result={kind}
        data-session-id={sessionId}
        onClick={onClick}
        class="flex w-full items-start gap-2.5 px-4 py-2.5 text-left select-none active:bg-hover"
      >
        {kind === "hit" ? (
          <MessageSquareText size={17} class="mt-0.5 shrink-0 text-fg-muted" aria-hidden />
        ) : (
          <Sparkles size={17} class="mt-0.5 shrink-0 text-fg-muted" aria-hidden />
        )}
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="flex min-w-0 items-center gap-2">
            <span class="min-w-0 flex-1 truncate">{title}</span>
            {envId && <DeviceMarker name={connectionFor(envId)?.name.value ?? ""} />}
            {trailing && <span class="max-w-[40%] shrink-0 truncate text-[15px] text-fg-muted">{trailing}</span>}
          </span>
          {detail && <span class="line-clamp-2 text-[15px] leading-snug text-fg-muted">{detail}</span>}
        </span>
      </button>
    </div>
  );
}
