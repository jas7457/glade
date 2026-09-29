/**
 * A chat's model and thinking level: what the pickers show and the actions that change them
 * (optimistic, rolled back when the agent refuses). Used by the chat composer and the iPhone's
 * title bar (I-172), so both change the same state the same way.
 */
import { clampThinkingLevel, sameModel, type ModelInfo, type ModelRef, type ThinkingLevel } from "@glade/protocol";
import { apiForSession } from "@glade/app-core/state/env-api";
import { getChatSession, runAction } from "@glade/app-core/state/chat-session";
import { harnessCapabilities } from "@glade/app-core/state/harnesses";
import { envIdOfSession, sessionsById, shellOf, visibleModelsOf } from "@glade/app-core/state/store";

export function modelInfo(models: ModelInfo[], ref: ModelRef | null): ModelInfo | undefined {
  return ref ? models.find((m) => sameModel(m, ref)) : undefined;
}

/** Switch the chat's model; its thinking levels follow the new model's. */
export function setChatModel(chatId: string, models: ModelInfo[], model: ModelRef): void {
  const store = getChatSession(chatId);
  const info = modelInfo(models, model);
  const prev = store.state.value;
  store.state.value = {
    ...prev,
    model,
    ...(info ? { thinkingLevels: info.thinkingLevels, thinkingLevel: clampThinkingLevel(info.thinkingLevels, prev.thinkingLevel) } : {}),
  };
  void runAction(() => apiForSession(chatId).setModel(chatId, model), "Could not change model").then((ok) => {
    if (!ok) store.state.value = prev;
  });
}

export function setChatThinkingLevel(chatId: string, level: ThinkingLevel): void {
  const store = getChatSession(chatId);
  const prev = store.state.value;
  store.state.value = { ...prev, thinkingLevel: level };
  void runAction(() => apiForSession(chatId).setThinkingLevel(chatId, level), "Could not change thinking level").then((ok) => {
    if (!ok) store.state.value = prev;
  });
}

/** The model/thinking picker props for a chat; `null` when its agent picks its own model (I-119). */
export function chatModelPickerProps(chatId: string) {
  const envId = envIdOfSession(chatId);
  if (harnessCapabilities(sessionsById.value.get(chatId)?.harness, envId).models === false) return null;
  const models = visibleModelsOf(shellOf(envId));
  const state = getChatSession(chatId).state.value;
  return {
    model: state.model,
    models,
    onModelChange: (model: ModelRef) => setChatModel(chatId, models, model),
    thinkingLevel: state.thinkingLevel,
    thinkingLevels: state.thinkingLevels,
    onThinkingChange: (level: ThinkingLevel) => setChatThinkingLevel(chatId, level),
  };
}
