/**
 * Saved prompts (I-098): add, edit, delete and reorder `settings.prompts`. Every change sends the
 * whole list (the server validates it) through `updateSettings`, which applies it optimistically.
 */
import type { SavedPrompt } from "@glade/protocol";
import { hostSettings as settings, updateHostSettings as updateSettings } from "./host-settings";

export type PromptDraft = Omit<SavedPrompt, "id">;

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `p-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function current(): SavedPrompt[] {
  return settings.value.prompts ?? [];
}

function clean(draft: PromptDraft): PromptDraft {
  const description = draft.description?.trim();
  return { name: draft.name.trim(), ...(description ? { description } : {}), body: draft.body, projectId: draft.projectId };
}

/** Add a prompt at the end of the list; resolves to its id (`null` if saving failed). */
export async function addPrompt(draft: PromptDraft): Promise<string | null> {
  const prompt: SavedPrompt = { id: newId(), ...clean(draft) };
  return (await updateSettings({ prompts: [...current(), prompt] })) ? prompt.id : null;
}

export function updatePrompt(id: string, draft: PromptDraft): Promise<boolean> {
  return updateSettings({ prompts: current().map((p) => (p.id === id ? { id, ...clean(draft) } : p)) });
}

export function deletePrompt(id: string): Promise<boolean> {
  return updateSettings({ prompts: current().filter((p) => p.id !== id) });
}

/**
 * Move a prompt one place up or down among the prompts of the same scope (global or its project);
 * other prompts keep their positions.
 */
export function movePrompt(id: string, direction: -1 | 1): Promise<boolean> {
  const list = current();
  const index = list.findIndex((p) => p.id === id);
  if (index === -1) return Promise.resolve(false);
  const scope = list[index]!.projectId;
  let other = index + direction;
  while (other >= 0 && other < list.length && list[other]!.projectId !== scope) other += direction;
  if (other < 0 || other >= list.length) return Promise.resolve(false);
  const next = list.slice();
  [next[index], next[other]] = [next[other]!, next[index]!];
  return updateSettings({ prompts: next });
}
