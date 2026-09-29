/**
 * What the side question UI does (I-140): ask (the `/btw` built-in and the composer's Ask Aside
 * button), stop, dismiss, and hand an answer to the agent (prefill the composer, or queue it). The
 * request goes to the chat's own environment (`apiForSession`), so it works on remote ones too.
 */
import { sideQuestionNote, type SideQuestionMessage } from "@glade/protocol";
import { apiForSession } from "@glade/app-core/state/env-api";
import { getChatSession, runAction } from "@glade/app-core/state/chat-session";
import { harnessCapabilities } from "@glade/app-core/state/harnesses";
import { envIdOfSession, sessionsById } from "@glade/app-core/state/store";
import { prefillComposer } from "./composer-prefill";

/**
 * Ask a side question in session `chatId`, or a follow-up in the card `parentId` (I-156); resolves
 * false when it couldn't be asked (toast shown).
 */
export function askSideQuestion(chatId: string, question: string, parentId?: string): Promise<boolean> {
  const api = apiForSession(chatId);
  return runAction(
    () => (parentId ? api.askSideQuestion(chatId, question.trim(), parentId) : api.askSideQuestion(chatId, question.trim())),
    "Could not ask the side question",
  );
}

export function stopSideQuestion(chatId: string, id: string): Promise<boolean> {
  return runAction(() => apiForSession(chatId).stopSideQuestion(chatId, id), "Could not stop the side question");
}

export function dismissSideQuestion(chatId: string, id: string): Promise<boolean> {
  return runAction(() => apiForSession(chatId).dismissSideQuestion(chatId, id), "Could not dismiss the side question");
}

/**
 * "Tell the Agent": put the card's questions and answers (the whole thread, I-156) into the
 * composer to edit and send (or queue).
 */
export function tellAgent(chatId: string, message: SideQuestionMessage): void {
  prefillComposer(chatId, sideQuestionNote(message));
}

/** "Add to Queue": send the note (the whole thread) as a follow-up (queued while the agent works, sent now when idle). */
export function addToQueue(chatId: string, message: SideQuestionMessage): Promise<boolean> {
  const running = getChatSession(chatId).state.value.isRunning;
  const steering = harnessCapabilities(sessionsById.value.get(chatId)?.harness, envIdOfSession(chatId)).steering;
  return runAction(
    () => apiForSession(chatId).prompt(chatId, { text: sideQuestionNote(message), ...(running && steering ? { behavior: "followUp" as const } : {}) }),
    "Could not queue the message",
  );
}
