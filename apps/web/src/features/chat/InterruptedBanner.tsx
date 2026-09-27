/**
 * Banner above the composer for a chat whose last run was cut off (app quit, crash, agent died):
 * "Continue" sends a follow-up prompt, "Dismiss" clears the flag. The server clears it on any
 * new prompt too, and pushes the updated session. `sessionId` is the conversation's session.
 */
import { useState } from "preact/hooks";
import { CirclePause } from "lucide-preact";
import { api } from "@/lib/api";
import { runAction } from "@/state/chat-session";
import { dismissInterrupted } from "@/state/actions";
import { Button } from "@/ui";

export const CONTINUE_PROMPT = "Continue where you left off.";

export function InterruptedBanner({ chatId: sessionId }: { chatId: string }) {
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await fn();
    setBusy(false);
  };
  return (
    <div role="status" class="mb-2 flex items-center gap-2 rounded-[10px] border-[0.5px] border-warning/30 bg-warning/10 py-1.5 pr-1.5 pl-3 text-warning">
      <CirclePause size={14} class="shrink-0" />
      <span class="min-w-0 flex-1">This run was interrupted when Glade quit.</span>
      <Button
        size="sm"
        disabled={busy}
        onClick={() => void act(() => runAction(() => api.prompt(sessionId, { text: CONTINUE_PROMPT }), "Could not continue"))}
      >
        Continue
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => dismissInterrupted(sessionId))}>
        Dismiss
      </Button>
    </div>
  );
}
