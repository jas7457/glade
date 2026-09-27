/**
 * Saved prompts (I-098) live in `Settings.prompts` (settings.json in Glade's data folder, never
 * in the repo). This validates the list a client sends and drops a deleted project's prompts.
 */
import { normalizePrompts, type DeepPartial, type Settings } from "@glade/protocol";
import type { AppContext } from "./context.js";
import { HttpError } from "./errors.js";

/** `patch` with a validated `prompts` list (400 when invalid); other keys are left alone. */
export function sanitizeSettingsPatch(patch: DeepPartial<Settings>): DeepPartial<Settings> {
  if (!patch || typeof patch !== "object" || !("prompts" in patch) || patch.prompts === undefined) return patch;
  try {
    return { ...patch, prompts: normalizePrompts(patch.prompts) };
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
}

/** Remove the prompts of a deleted project and push the new settings (no-op when it had none). */
export function dropProjectPrompts(ctx: AppContext, projectId: string): void {
  const prompts = ctx.store.getSettings().prompts ?? [];
  if (!prompts.some((p) => p.projectId === projectId)) return;
  const settings = ctx.store.updateSettings({ prompts: prompts.filter((p) => p.projectId !== projectId) });
  ctx.broadcast({ type: "settings", settings });
}
