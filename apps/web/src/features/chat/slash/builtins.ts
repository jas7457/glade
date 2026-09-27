/**
 * Glade's built-in slash commands: the single registry of their names, descriptions and
 * behaviour. They run in the web app (API calls / navigation), never reach the agent as text.
 * Harness commands (extensions, skills, prompt templates) come from the server and are sent
 * as ordinary prompts. To add a built-in, add an entry to BUILTIN_COMMANDS. Built-ins that need
 * a harness feature name it in `requires` and are hidden for harnesses without it (I-065).
 */
import { type HarnessCapabilities, type ModelInfo, type ModelRef, type SlashCommand, type ThinkingLevel } from "@glade/protocol";
import { api } from "@/lib/api";
import { routes } from "@/app/routes";
import { renameFromSession } from "@/state/actions";
import { getChatSession } from "@/state/chat-session";
import { sessionsById, workspacesById } from "@/state/store";
import { notify, showToast } from "@/state/toasts";
import { describeStats } from "../context-meter";
import { thinkingLabel } from "../composer-utils";

/** What a built-in can do. Provided by the composer. */
export interface SlashContext {
  /** Session id of the conversation; `null` in the new-chat composer. */
  chatId: string | null;
  projectId: string | null;
  navigate: (path: string) => void;
  models: ModelInfo[];
  thinkingLevels: ThinkingLevel[];
  setModel: (model: ModelRef) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
  openPicker: (which: "model" | "thinking") => void;
}

export interface BuiltinCommand extends SlashCommand {
  source: "builtin";
  /** Only offered once the chat exists (hidden in the new-chat composer). */
  needsChat: boolean;
  /** Harness capability it needs; hidden when the chat's harness lacks it (I-065). */
  requires?: keyof HarnessCapabilities;
  /** Resolve `true` when handled (the composer clears), `false` to keep the text for editing. */
  run: (args: string, ctx: SlashContext) => boolean | Promise<boolean>;
}

function requireChat(ctx: SlashContext): string {
  if (!ctx.chatId) throw new Error("needs a chat"); // never offered without one (needsChat)
  return ctx.chatId;
}

/** Resolve `/model <query>`: a unique match (exact first, then substring) or the candidates. */
export function matchModel(models: ModelInfo[], query: string): { match: ModelInfo | null; candidates: ModelInfo[] } {
  const q = query.trim().toLowerCase();
  if (!q) return { match: null, candidates: models };
  const key = (m: ModelInfo) => `${m.provider}/${m.id}`.toLowerCase();
  const exact = models.filter((m) => key(m) === q || m.id.toLowerCase() === q || m.name.toLowerCase() === q);
  if (exact.length === 1) return { match: exact[0]!, candidates: exact };
  const partial = models.filter((m) => key(m).includes(q) || m.name.toLowerCase().includes(q));
  return { match: partial.length === 1 ? partial[0]! : null, candidates: partial };
}

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  {
    name: "compact",
    source: "builtin",
    description: "Summarize the conversation to free up context",
    argsHint: "[instructions]",
    needsChat: true,
    requires: "compact",
    run: (args, ctx) => {
      const chatId = requireChat(ctx);
      const store = getChatSession(chatId);
      if (store.state.value.isRunning) {
        notify("warning", "Wait for the current reply to finish before compacting.");
        return false;
      }
      // Show the working state right away; pi's compaction events confirm/clear it.
      store.state.value = { ...store.state.value, isCompacting: true };
      api.compact(chatId, args || undefined).then(
        () => {
          store.state.value = { ...store.state.value, isCompacting: false };
        },
        (err: Error) => {
          store.state.value = { ...store.state.value, isCompacting: false };
          notify("error", `Could not compact: ${err.message}`);
        },
      );
      return true;
    },
  },
  {
    name: "new",
    source: "builtin",
    description: "Start a new chat in this project",
    needsChat: true,
    run: (_args, ctx) => {
      const workspaceId = ctx.chatId ? sessionsById.value.get(ctx.chatId)?.workspaceId : undefined;
      const projectId = ctx.projectId ?? (workspaceId ? workspacesById.value.get(workspaceId)?.projectId : null) ?? null;
      ctx.navigate(projectId ? routes.project(projectId) : routes.home());
      return true;
    },
  },
  {
    name: "name",
    source: "builtin",
    description: "Rename this chat",
    argsHint: "<title>",
    needsChat: true,
    run: async (args, ctx) => {
      if (!args) {
        notify("warning", "Usage: /name <title>");
        return false;
      }
      return renameFromSession(requireChat(ctx), args);
    },
  },
  {
    name: "model",
    source: "builtin",
    description: "Switch model (opens the picker without a query)",
    argsHint: "[query]",
    needsChat: false,
    run: (args, ctx) => {
      const { match, candidates } = matchModel(ctx.models, args);
      if (match) {
        ctx.setModel({ provider: match.provider, id: match.id });
        return true;
      }
      if (args && candidates.length === 0) {
        notify("warning", `No model matches “${args}”.`);
        return false;
      }
      ctx.openPicker("model");
      return true;
    },
  },
  {
    name: "thinking",
    source: "builtin",
    description: "Set the thinking level",
    argsHint: "[level]",
    needsChat: false,
    run: (args, ctx) => {
      const levels = ctx.thinkingLevels;
      if (levels.length <= 1) {
        notify("warning", "This model doesn't support thinking levels.");
        return false;
      }
      if (!args) {
        ctx.openPicker("thinking");
        return true;
      }
      const q = args.toLowerCase();
      const level = levels.find((l) => l === q || thinkingLabel(l).toLowerCase() === q);
      if (!level) {
        notify("warning", `Unknown thinking level “${args}”. Available: ${levels.join(", ")}.`);
        return false;
      }
      ctx.setThinkingLevel(level);
      return true;
    },
  },
  {
    name: "export",
    source: "builtin",
    description: "Export this chat to an HTML file",
    needsChat: true,
    requires: "exportHtml",
    run: async (_args, ctx) => {
      try {
        const { path } = await api.exportSession(requireChat(ctx));
        showToast({
          level: "success",
          title: "Chat exported",
          message: path,
          timeoutMs: 10_000,
          action: {
            label: "Reveal",
            onClick: () => void api.revealFile(path).catch((err: Error) => notify("error", `Could not reveal: ${err.message}`)),
          },
        });
        return true;
      } catch (err) {
        notify("error", `Could not export: ${(err as Error).message}`);
        return false;
      }
    },
  },
  {
    name: "stats",
    source: "builtin",
    description: "Show context usage, tokens and cost",
    needsChat: true,
    run: (_args, ctx) => {
      showToast({ level: "info", title: "Session stats", message: describeStats(getChatSession(requireChat(ctx)).state.value), timeoutMs: 10_000 });
      return true;
    },
  },
  {
    name: "settings",
    source: "builtin",
    description: "Open settings",
    needsChat: false,
    run: (_args, ctx) => {
      ctx.navigate(routes.settings());
      return true;
    },
  },
];

/**
 * Built-ins offered in a composer: the new-chat composer only gets those that work without a
 * chat, and those needing a harness capability only show when `capabilities` has it (omitted =
 * all).
 */
export function builtinCommands(hasChat: boolean, capabilities?: HarnessCapabilities): SlashCommand[] {
  return BUILTIN_COMMANDS.filter((c) => (hasChat || !c.needsChat) && (!c.requires || !capabilities || capabilities[c.requires])).map(({ name, description, source, argsHint }) => ({
    name,
    source,
    ...(description ? { description } : {}),
    ...(argsHint ? { argsHint } : {}),
  }));
}

export function findBuiltin(name: string): BuiltinCommand | undefined {
  return BUILTIN_COMMANDS.find((c) => c.name === name);
}
