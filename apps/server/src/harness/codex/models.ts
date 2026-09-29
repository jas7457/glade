/**
 * Codex's models and reasoning efforts → Glade's model and thinking pickers (I-177). Pure.
 *
 * Models come from `model/list` (hidden ones left out) as `codex/<id>`: Glade's own provider name
 * for "whatever Codex lists", so they never mix with pi's `openai/…` models. `displayName` and
 * `description` become the picker's name and muted detail line under a "Codex" header (I-175).
 *
 * Reasoning efforts map onto Glade's thinking levels one to one (`none` = off, `minimal`, `low`,
 * `medium`, `high`, `xhigh`, `max`); efforts Glade has no level for (Codex's `ultra`) aren't
 * offered.
 */
import { THINKING_LEVELS, type ModelInfo, type ModelRef, type ThinkingLevel } from "@glade/protocol";
import type { CodexModel } from "./protocol.js";

export const CODEX_PROVIDER = "codex";
/** Group header of Codex's models in the pickers. */
export const CODEX_MODEL_GROUP = "Codex";

/** Context window until Codex reports the model's (`thread/tokenUsage/updated`). */
export const DEFAULT_CONTEXT_WINDOW = 272_000;

/** Codex effort → Glade thinking level (`null` when Glade has none for it). */
export function effortToLevel(effort: string | null | undefined): ThinkingLevel | null {
  if (!effort) return null;
  if (effort === "none") return "off";
  return (THINKING_LEVELS as readonly string[]).includes(effort) && effort !== "off" ? (effort as ThinkingLevel) : null;
}

/** Glade thinking level → Codex effort. */
export function levelToEffort(level: ThinkingLevel): string {
  return level === "off" ? "none" : level;
}

export function codexThinkingLevels(model: CodexModel | undefined): ThinkingLevel[] {
  if (!model) return ["low", "medium", "high"];
  const levels = new Set(model.supportedReasoningEfforts.map((e) => effortToLevel(e.reasoningEffort)).filter((l): l is ThinkingLevel => l !== null));
  const out = THINKING_LEVELS.filter((l) => levels.has(l));
  return out.length ? out : ["off"];
}

export function translateCodexModel(model: CodexModel): ModelInfo {
  const input: Array<"text" | "image"> = model.inputModalities?.includes("image") ? ["text", "image"] : ["text"];
  return {
    provider: CODEX_PROVIDER,
    id: model.id,
    name: model.displayName || model.id,
    ...(model.description ? { description: model.description } : {}),
    group: CODEX_MODEL_GROUP,
    thinkingLevels: codexThinkingLevels(model),
    input,
  };
}

/** The picker's list: visible models, Codex's default first. */
export function translateCodexModels(models: readonly CodexModel[], defaultId?: string | null): ModelInfo[] {
  const visible = models.filter((m) => !m.hidden || m.id === defaultId);
  const first = defaultId ? visible.findIndex((m) => m.id === defaultId) : visible.findIndex((m) => m.isDefault);
  const ordered = first > 0 ? [visible[first]!, ...visible.slice(0, first), ...visible.slice(first + 1)] : visible;
  return ordered.map(translateCodexModel);
}

/** The Codex model id of a Glade model ref (`null` for other providers). */
export function codexModelId(model: ModelRef | null | undefined): string | null {
  return model && model.provider === CODEX_PROVIDER && model.id ? model.id : null;
}

export function findCodexModel(models: readonly CodexModel[], id: string | null | undefined): CodexModel | undefined {
  return id ? models.find((m) => m.id === id || m.model === id) : undefined;
}

/** The thinking level a chat on `model` starts with: the effort Codex would use, as a level. */
export function defaultLevel(model: CodexModel | undefined, configured?: string | null): ThinkingLevel {
  const levels = codexThinkingLevels(model);
  const wanted = effortToLevel(configured) ?? effortToLevel(model?.defaultReasoningEffort) ?? "medium";
  return levels.includes(wanted) ? wanted : (levels.includes("medium") ? "medium" : levels[0]!);
}
