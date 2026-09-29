/**
 * A side question (`/btw`, Ask Aside; I-140): the question, the answer streaming in (Stop while it
 * does), and once it's answered: a Reply field for a follow-up in the same card (a small thread,
 * I-156), Tell the Agent (prefills the composer), Add to Queue (sends it as a follow-up) and
 * Dismiss. The hand-offs pass on the whole thread. The agent never sees any of it unless the user
 * passes it on.
 */
import { memo } from "preact/compat";
import { useState } from "preact/hooks";
import { CornerDownLeft, MessageCircleQuestionMark, Square } from "lucide-preact";
import { latestSideQuestionTurn, sideQuestionStreaming, sideQuestionTurns, type SideQuestionMessage, type SideQuestionTurn } from "@glade/protocol";
import { Button, IconButton, Spinner, TextField, Tooltip } from "@glade/app-core/ui";
import { Markdown } from "./Markdown";
import { useSmoothText } from "./smooth-text";
import { addToQueue, askSideQuestion, dismissSideQuestion, stopSideQuestion, tellAgent } from "./side-question-actions";

/** One question of the card and its answer. */
function Turn({ turn, first }: { turn: SideQuestionTurn; first: boolean }) {
  const streaming = turn.status === "streaming";
  const shown = useSmoothText(turn.answer, streaming);
  return (
    <div data-turn={turn.id} class={first ? undefined : "mt-2.5 border-t-[0.5px] border-agent/20 pt-2.5"}>
      <div class="selectable mb-1.5 text-[0.95rem] font-medium break-words whitespace-pre-wrap text-fg">{turn.question}</div>
      {shown ? (
        <Markdown text={shown} streaming={streaming || shown.length < turn.answer.length} class="my-0 text-fg" />
      ) : streaming ? (
        <div class="text-[0.92rem] text-fg-subtle">Thinking about it…</div>
      ) : null}
      {turn.status === "stopped" && <div class="mt-1 text-[0.85rem] text-fg-subtle">Stopped</div>}
      {turn.status === "error" && (
        <div role="alert" class="selectable mt-1 text-[0.9rem] break-words whitespace-pre-wrap text-danger">
          {turn.error || "The side question failed"}
        </div>
      )}
      {turn.partialContext && !streaming && (
        <Tooltip content="The chat is long: the answer saw its start, your messages from the middle, and the recent part">
          <div class="mt-1 inline-block text-[0.82rem] text-fg-subtle select-none">(only saw part of the chat)</div>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * The Reply field: asks a follow-up in this card (↩ sends). It stays while an answer streams (so
 * focus stays and the next follow-up can be typed), but sends only once it's done.
 */
function ReplyField({ chatId, cardId, busy }: { chatId: string; cardId: string; busy: boolean }) {
  const [text, setText] = useState("");
  const send = async () => {
    const question = text.trim();
    if (!question || busy) return;
    setText("");
    if (!(await askSideQuestion(chatId, question, cardId))) setText(question);
  };
  return (
    <div class="mt-2.5 flex items-center gap-1">
      <TextField
        size="sm"
        aria-label="Reply to the side question"
        placeholder="Ask a follow-up…"
        value={text}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <IconButton label="Send follow-up (↩)" size="sm" disabled={busy || !text.trim()} onClick={() => void send()}>
        <CornerDownLeft />
      </IconButton>
    </div>
  );
}

export const SideQuestionCard = memo(function SideQuestionCard({ message, chatId }: { message: SideQuestionMessage; chatId: string }) {
  const streaming = sideQuestionStreaming(message);
  const latest = latestSideQuestionTurn(message);
  const turns = sideQuestionTurns(message);
  const answered = !streaming && turns.some((t) => t.answer.trim().length > 0);
  const model = latest.model ?? message.model;
  const thread = turns.length > 1;

  return (
    <div
      class="mt-6 overflow-hidden rounded-[10px] border-[0.5px] border-agent/35 bg-agent/[0.05] first:mt-0"
      data-agent-color="violet"
      data-role="side"
      data-status={latest.status}
      aria-label="Side question"
    >
      <div class="flex min-h-8 items-center gap-2 py-1 pr-1.5 pl-2.5 select-none">
        <MessageCircleQuestionMark size={13} strokeWidth={2.25} class="shrink-0 text-agent" aria-hidden="true" />
        <span class="shrink-0 text-[0.88rem] font-semibold text-agent">Side question</span>
        <Tooltip content="Answered separately: the agent doesn't see this unless you pass it on">
          <span class="min-w-0 truncate text-[0.85rem] text-fg-subtle">Not seen by the agent</span>
        </Tooltip>
        <div class="flex-1" />
        {model && <span class="shrink-0 truncate text-[0.8rem] text-fg-subtle">{model}</span>}
        {streaming && <Spinner size={12} />}
        {streaming && (
          <IconButton
            label="Stop"
            size="sm"
            onClick={() => {
              for (const turn of turns) if (turn.status === "streaming") void stopSideQuestion(chatId, turn.id);
            }}
          >
            <Square fill="currentColor" strokeWidth={0} />
          </IconButton>
        )}
      </div>
      <div class="border-t-[0.5px] border-agent/20 px-3 pt-2 pb-2.5">
        {turns.map((turn, i) => (
          <Turn key={turn.id} turn={turn} first={i === 0} />
        ))}
        <ReplyField chatId={chatId} cardId={message.id} busy={streaming} />
        {!streaming && (
          <>
            <div class="mt-2 flex flex-wrap items-center gap-1.5">
              {answered && (
                <>
                  <Tooltip content={thread ? "Put the questions and answers in the message box to edit and send" : "Put the question and answer in the message box to edit and send"}>
                    <Button size="sm" onClick={() => tellAgent(chatId, message)}>
                      Tell the Agent
                    </Button>
                  </Tooltip>
                  <Tooltip content={thread ? "Send the questions and answers to the agent after its current work" : "Send the question and answer to the agent after its current work"}>
                    <Button size="sm" onClick={() => void addToQueue(chatId, message)}>
                      Add to Queue
                    </Button>
                  </Tooltip>
                </>
              )}
              <Button size="sm" variant="ghost" onClick={() => void dismissSideQuestion(chatId, message.id)}>
                Dismiss
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
});
