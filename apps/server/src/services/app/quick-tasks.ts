/**
 * Quick tasks (I-198): chat titles, `/name`, chat summaries, search and commit messages run with
 * one Glade-wide choice, `Settings.models.quickTasks` (agent + model), for chats of every agent.
 * It's used when that agent is registered, offered here (installed and turned on) and can run quick
 * tasks (`capabilities.quickTasks`, plus `complete` for everything but titles). Otherwise the
 * fallback from before I-198 applies:
 *
 * - titles: the chat's own agent, with Claude Haiku 4.5 when it lists it, else the chat's model;
 * - completions (summaries, search, commit messages): the default agent, with Haiku when it lists
 *   it, else its own default model.
 *
 *   const runner = await quickTitleRunner(settings, harnesses, { harness, model: session.model });
 *   const title = runner && (await quickTitle(runner, { firstMessage, cwd }));
 *   const completion = await quickCompletionRunner(settings, harnesses);
 *   await completion?.harness.complete?.({ prompt, model: completion.model, cwd });
 */
import { sameModel, type DeepPartial, type ModelInfo, type ModelRef, type Settings } from "@glade/protocol";
import type { HarnessRegistry } from "../../harness/registry.js";
import { canGenerateTitles, cleanTitle, generateTitleWith, titlePrompt } from "../../harness/title.js";
import type { AgentHarness, GenerateTitleOptions } from "../../harness/types.js";
import { HttpError } from "./errors.js";

/** The small model quick tasks fall back to when the agent lists it. */
export const DEFAULT_SMALL_MODEL: ModelRef = { provider: "anthropic", id: "claude-haiku-4-5" };

/** Which agent runs a quick task, with which model. */
export interface QuickTaskRunner {
  harness: AgentHarness;
  /** `null` = the agent's own default. */
  model: ModelRef | null;
  /** From the quick-tasks setting (else the fallback). */
  configured: boolean;
}

/** Whether a harness can be the quick-tasks agent (matches its `capabilities.quickTasks`). */
export function canRunQuickTasks(harness: AgentHarness): boolean {
  return !!harness.info.capabilities.quickTasks && canGenerateTitles(harness);
}

/**
 * The quick-tasks setting when it can be used here: its agent registered, offered and able to run
 * quick tasks (`"complete"`: with a one-shot `complete`, for summaries/search/commit messages).
 */
export function configuredQuickTasks(settings: Settings, harnesses: HarnessRegistry, need: "title" | "complete"): QuickTaskRunner | null {
  const chosen = settings.models.quickTasks;
  if (!chosen || typeof chosen.harness !== "string" || !chosen.model) return null;
  const harness = harnesses.get(chosen.harness);
  if (!harness || !harnesses.isOffered(harness) || !canRunQuickTasks(harness)) return null;
  if (need === "complete" && !harness.complete) return null;
  return { harness, model: chosen.model, configured: true };
}

/** Haiku when the harness lists it, else `null`. */
export async function defaultSmallModel(harness: AgentHarness): Promise<ModelRef | null> {
  const models = await harness.listModels().catch(() => [] as ModelInfo[]);
  return models.some((m) => sameModel(m, DEFAULT_SMALL_MODEL)) ? DEFAULT_SMALL_MODEL : null;
}

/** Who writes a chat's title: the quick-tasks agent, else the chat's own (`null`: nobody can). */
export async function quickTitleRunner(
  settings: Settings,
  harnesses: HarnessRegistry,
  chat: { harness: AgentHarness | undefined; model: ModelRef | null },
): Promise<QuickTaskRunner | null> {
  const configured = configuredQuickTasks(settings, harnesses, "title");
  if (configured) return configured;
  if (!chat.harness || !canGenerateTitles(chat.harness)) return null;
  return { harness: chat.harness, model: (await defaultSmallModel(chat.harness)) ?? chat.model, configured: false };
}

/** The harness one-shot quick tasks run in (no model lookup): the quick-tasks agent, else the default. */
export function quickCompletionHarness(settings: Settings, harnesses: HarnessRegistry): AgentHarness | null {
  const configured = configuredQuickTasks(settings, harnesses, "complete");
  if (configured) return configured.harness;
  const harness = harnesses.default();
  return harness.complete ? harness : null;
}

/** Who runs one-shot quick tasks (summaries, search, commit messages); `null` when nobody can. */
export async function quickCompletionRunner(settings: Settings, harnesses: HarnessRegistry): Promise<QuickTaskRunner | null> {
  const configured = configuredQuickTasks(settings, harnesses, "complete");
  if (configured) return configured;
  const harness = harnesses.default();
  if (!harness.complete) return null;
  return { harness, model: await defaultSmallModel(harness), configured: false };
}

/**
 * A title with the runner. A chosen quick-tasks model is honoured: it goes through `complete`
 * when the agent has it (an agent's own `generateTitle` may pick its own model, e.g. Claude
 * Code's always-Haiku); otherwise `generateTitleWith`.
 */
export function quickTitle(runner: QuickTaskRunner, options: Omit<GenerateTitleOptions, "model">): Promise<string | null> {
  if (runner.configured && runner.harness.complete) {
    return runner.harness.complete({ prompt: titlePrompt(options.firstMessage, options.excerpt), model: runner.model, cwd: options.cwd }).then(cleanTitle);
  }
  return generateTitleWith(runner.harness, { ...options, model: runner.model });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isModelRef = (v: unknown): v is ModelRef => isRecord(v) && typeof v.provider === "string" && typeof v.id === "string";

/**
 * A settings patch's `models` (I-198), checked loosely: `quickTasks` is `null` or an agent id plus a
 * model (an agent that isn't registered is kept; quick tasks then fall back), `agents` an object of
 * objects. 400 otherwise.
 */
export function validateModelsPatch(patch: DeepPartial<Settings>): void {
  const models = (patch as { models?: unknown })?.models;
  if (models === undefined) return;
  if (!isRecord(models)) throw new HttpError(400, "models must be an object");
  const quick = models.quickTasks;
  if (quick !== undefined && quick !== null) {
    if (!isRecord(quick) || typeof quick.harness !== "string" || !quick.harness.trim() || !isModelRef(quick.model)) {
      throw new HttpError(400, "models.quickTasks must be null or { harness, model: { provider, id } }");
    }
  }
  const agents = models.agents;
  if (agents !== undefined) {
    if (!isRecord(agents) || Object.values(agents).some((a) => a !== undefined && !isRecord(a))) {
      throw new HttpError(400, "models.agents must map agent ids to objects");
    }
    for (const entry of Object.values(agents) as Array<Record<string, unknown> | undefined>) {
      const hidden = entry?.hiddenModels;
      if (hidden !== undefined && (!Array.isArray(hidden) || hidden.some((k) => typeof k !== "string"))) {
        throw new HttpError(400, "hiddenModels must be a list of model keys");
      }
    }
  }
}
