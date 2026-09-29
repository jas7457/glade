/**
 * Claude Code's models and thinking → Glade's model and thinking pickers (I-173). Pure.
 *
 * Models are the SDK's `supportedModels()` (aliases such as `sonnet`, `opus`, `haiku`, or full
 * ids), as `anthropic/<value>`; Claude Code's own "default" entry isn't listed (Glade's "Default"
 * means the harness default, I-050). Thinking levels:
 *
 *   off                    → `thinking: { type: "disabled" }`
 *   models with effort     → off + the model's effort levels (low … max): adaptive thinking
 *                            (or a fixed budget without adaptive support) + `effort: <level>`
 *   models without effort  → off / low / medium / high: a fixed thinking budget
 */
import { THINKING_LEVELS, type ModelInfo, type ModelRef, type ThinkingLevel } from "@glade/protocol";
import type { ClaudeModelInfo, ClaudeOptions } from "./sdk.js";

export const CLAUDE_PROVIDER = "anthropic";

/** Context window used when Claude Code hasn't reported one yet. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Thinking budgets for models without effort levels. */
const BUDGETS: Partial<Record<ThinkingLevel, number>> = { minimal: 2_000, low: 4_000, medium: 10_000, high: 32_000 };

export function claudeThinkingLevels(model: ClaudeModelInfo | undefined): ThinkingLevel[] {
  if (!model) return ["off", "low", "medium", "high"];
  if (model.supportsEffort && model.supportedEffortLevels?.length) {
    const levels = new Set<ThinkingLevel>(["off", ...model.supportedEffortLevels]);
    return THINKING_LEVELS.filter((l) => levels.has(l));
  }
  return ["off", "low", "medium", "high"];
}

/** Group header of Claude Code's models in the pickers (I-175). */
export const CLAUDE_MODEL_GROUP = "Claude Code";

/**
 * Name and description from Claude Code's `displayName` / `description` (I-175), like its /model
 * list: "Opus" + "Opus 5.5 · Best for everyday, complex tasks" → "Opus 5.5" + "Best for everyday,
 * complex tasks"; a description not starting with the display name ("Newer version available ·
 * …") keeps the display name and the whole description.
 */
export function claudeModelLabel(model: Pick<ClaudeModelInfo, "value" | "displayName" | "description">): { name: string; description?: string } {
  const display = (model.displayName || model.value).trim();
  const description = model.description?.trim() ?? "";
  if (!description) return { name: display };
  const at = description.indexOf(" · ");
  const head = at >= 0 ? description.slice(0, at).trim() : description;
  const rest = at >= 0 ? description.slice(at + 3).trim() : "";
  if (display && head.toLowerCase().startsWith(display.toLowerCase()) && head.length <= display.length + 24) {
    return { name: head, ...(rest ? { description: rest } : {}) };
  }
  return { name: display, description };
}

export function translateClaudeModel(model: ClaudeModelInfo): ModelInfo {
  return {
    provider: CLAUDE_PROVIDER,
    id: model.value,
    ...claudeModelLabel(model),
    group: CLAUDE_MODEL_GROUP,
    thinkingLevels: claudeThinkingLevels(model),
    input: ["text", "image"],
  };
}

/** The listed models (Claude Code's own "default" entry left out). */
export function translateClaudeModels(models: ClaudeModelInfo[]): ModelInfo[] {
  return models.filter((m) => m.value && m.value !== "default").map(translateClaudeModel);
}

/** The model id Claude Code gets for a Glade model ref (`null` = its default). */
export function claudeModelId(ref: ModelRef | null | undefined): string | null {
  return ref && ref.provider === CLAUDE_PROVIDER && ref.id && ref.id !== "default" ? ref.id : null;
}

/** Query options for a thinking level on a model. */
export function thinkingOptions(level: ThinkingLevel, model: ClaudeModelInfo | undefined): Pick<ClaudeOptions, "thinking" | "effort"> {
  if (level === "off") return { thinking: { type: "disabled" } };
  const effortLevels = model?.supportsEffort ? (model.supportedEffortLevels ?? []) : [];
  if ((effortLevels as string[]).includes(level)) {
    const effort = level as NonNullable<ClaudeOptions["effort"]>;
    return model?.supportsAdaptiveThinking ? { thinking: { type: "adaptive" }, effort } : { thinking: { type: "enabled", budgetTokens: BUDGETS[level] ?? 32_000 }, effort };
  }
  return { thinking: { type: "enabled", budgetTokens: BUDGETS[level] ?? 32_000 } };
}

/** The listed model a ref / Claude model id refers to (by alias, or its resolved id). */
export function findClaudeModel(models: ClaudeModelInfo[], id: string | null): ClaudeModelInfo | undefined {
  if (!id) return models.find((m) => m.value === "default");
  return models.find((m) => m.value === id) ?? models.find((m) => m.value !== "default" && m.resolvedModel === id);
}
