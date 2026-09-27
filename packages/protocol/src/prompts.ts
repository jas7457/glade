/**
 * Saved prompts (I-098): reusable text the user keeps in Glade (not in the repo), global or for
 * one project. They're stored in `Settings.prompts` and offered in the composer's `/` menu,
 * where picking one inserts its body (it's never sent on its own).
 */

export interface SavedPrompt {
  id: string;
  /** Shown in the `/` menu as `/<slug>` (see {@link promptCommandName}). */
  name: string;
  description?: string;
  /** Inserted into the composer as is (may contain `@file` mentions). */
  body: string;
  /** `null` = every chat; else only chats of this project. */
  projectId: string | null;
}

export const MAX_PROMPT_NAME = 80;
export const MAX_PROMPT_DESCRIPTION = 200;
export const MAX_PROMPT_BODY = 20_000;
export const MAX_PROMPTS = 500;

/** The `/` menu name of a prompt: lower-case, whitespace and `/` → `-` ("Review diff" → "review-diff"). */
export function promptCommandName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The prompts a chat in `projectId` offers (`null` = standalone chat): the project's first, then
 * the global ones, in their stored order; a global prompt with the same menu name as a project
 * prompt is left out (the project's wins).
 */
export function promptsFor(prompts: readonly SavedPrompt[] | null | undefined, projectId: string | null): SavedPrompt[] {
  const own = projectId ? (prompts ?? []).filter((p) => p.projectId === projectId) : [];
  const taken = new Set(own.map((p) => promptCommandName(p.name)));
  const global = (prompts ?? []).filter((p) => p.projectId === null && !taken.has(promptCommandName(p.name)));
  return [...own, ...global].filter((p) => promptCommandName(p.name) !== "");
}

/**
 * Validate and clean a prompt list from a client (trimmed names, no empty names/bodies, unique
 * ids). Throws an `Error` with a user-facing message when invalid.
 */
export function normalizePrompts(value: unknown): SavedPrompt[] {
  if (!Array.isArray(value)) throw new Error("prompts must be a list");
  if (value.length > MAX_PROMPTS) throw new Error(`At most ${MAX_PROMPTS} prompts`);
  const ids = new Set<string>();
  return value.map((raw, i): SavedPrompt => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const at = `prompts[${i}]`;
    if (typeof item.id !== "string" || !item.id) throw new Error(`${at}.id is required`);
    if (ids.has(item.id)) throw new Error(`${at}.id is a duplicate`);
    ids.add(item.id);
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name || !promptCommandName(name)) throw new Error(`${at}: a name is required`);
    if (name.length > MAX_PROMPT_NAME) throw new Error(`${at}: the name is too long`);
    if (typeof item.body !== "string" || !item.body.trim()) throw new Error(`${at}: the prompt text is required`);
    if (item.body.length > MAX_PROMPT_BODY) throw new Error(`${at}: the prompt text is too long`);
    if (item.description !== undefined && item.description !== null && typeof item.description !== "string") {
      throw new Error(`${at}.description must be text`);
    }
    const description = typeof item.description === "string" ? item.description.trim().slice(0, MAX_PROMPT_DESCRIPTION) : "";
    if (item.projectId !== null && typeof item.projectId !== "string") throw new Error(`${at}.projectId must be a project id or null`);
    return { id: item.id, name, ...(description ? { description } : {}), body: item.body, projectId: item.projectId };
  });
}
