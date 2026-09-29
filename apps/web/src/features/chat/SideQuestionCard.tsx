/**
 * A side question (`/btw`, Ask Aside; I-140): the question, the answer streaming in (Stop while it
 * does), and once it's answered: Tell the Agent (prefills the composer), Add to Queue (sends it as
 * a follow-up) and Dismiss. The agent never sees any of it unless the user passes it on.
 */
import { memo } from "preact/compat";
import { MessageCircleQuestionMark, Square } from "lucide-preact";
import type { SideQuestionMessage } from "@glade/protocol";
import { Button, IconButton, Spinner, Tooltip } from "@/ui";
import { Markdown } from "./Markdown";
import { useSmoothText } from "./smooth-text";
import { addToQueue, dismissSideQuestion, stopSideQuestion, tellAgent } from "./side-question-actions";

export const SideQuestionCard = memo(function SideQuestionCard({ message, chatId }: { message: SideQuestionMessage; chatId: string }) {
  const streaming = message.status === "streaming";
  const shown = useSmoothText(message.answer, streaming);
  const answered = !streaming && message.answer.trim().length > 0;

  return (
    <div
      class="mt-6 overflow-hidden rounded-[10px] border-[0.5px] border-accent/35 bg-accent/[0.04] first:mt-0"
      data-role="side"
      data-status={message.status}
      aria-label="Side question"
    >
      <div class="flex min-h-8 items-center gap-2 py-1 pr-1.5 pl-2.5 select-none">
        <MessageCircleQuestionMark size={13} strokeWidth={2.25} class="shrink-0 text-accent" aria-hidden="true" />
        <span class="shrink-0 text-[0.88rem] font-semibold text-accent">Side question</span>
        <Tooltip content="Answered separately: the agent doesn't see this unless you pass it on">
          <span class="min-w-0 truncate text-[0.85rem] text-fg-subtle">Not seen by the agent</span>
        </Tooltip>
        <div class="flex-1" />
        {message.model && <span class="shrink-0 truncate text-[0.8rem] text-fg-subtle">{message.model}</span>}
        {streaming && <Spinner size={12} />}
        {streaming && (
          <IconButton label="Stop" size="sm" onClick={() => void stopSideQuestion(chatId, message.id)}>
            <Square fill="currentColor" strokeWidth={0} />
          </IconButton>
        )}
      </div>
      <div class="border-t-[0.5px] border-accent/20 px-3 pt-2 pb-2.5">
        <div class="selectable mb-1.5 text-[0.95rem] font-medium break-words whitespace-pre-wrap text-fg">{message.question}</div>
        {shown ? (
          <Markdown text={shown} streaming={streaming || shown.length < message.answer.length} class="my-0 text-fg" />
        ) : streaming ? (
          <div class="text-[0.92rem] text-fg-subtle">Thinking about it…</div>
        ) : null}
        {message.status === "stopped" && <div class="mt-1 text-[0.85rem] text-fg-subtle">Stopped</div>}
        {message.status === "error" && (
          <div role="alert" class="selectable mt-1 text-[0.9rem] break-words whitespace-pre-wrap text-danger">
            {message.error || "The side question failed"}
          </div>
        )}
        {!streaming && (
          <div class="mt-2.5 flex flex-wrap items-center gap-1.5">
            {answered && (
              <>
                <Tooltip content="Put the question and answer in the message box to edit and send">
                  <Button size="sm" onClick={() => tellAgent(chatId, message)}>
                    Tell the Agent
                  </Button>
                </Tooltip>
                <Tooltip content="Send the question and answer to the agent after its current work">
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
        )}
      </div>
    </div>
  );
});
