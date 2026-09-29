/**
 * Glade's built-in slash commands: the single registry of their names, descriptions and
 * behaviour. They run in the web app (API calls / navigation), never reach the agent as text.
 * Harness commands (extensions, skills, prompt templates) come from the server and are sent
 * as ordinary prompts. To add a built-in, add an entry to BUILTIN_COMMANDS. Built-ins that need
 * a harness feature name it in `requires` and are hidden for harnesses without it (I-065).
 */
import { type HarnessCapabilities, type ModelInfo, type ModelRef, type SlashCommand, type ThinkingLevel } from "@glade/protocol";
import { downloadUrl } from "@glade/app-core/lib/download";
import { apiForSession, isThisMachine } from "@glade/app-core/state/env-api";
import { routes } from "@glade/app-core/app/routes";
import { renameFromSession } from "@glade/app-core/state/actions";
import { getChatSession } from "@glade/app-core/state/chat-session";
import { envIdOfSession, sessionsById, workspacesById } from "@glade/app-core/state/store";
import { dismissToast, notify, showToast } from "@glade/app-core/state/toasts";
import { describeStats } from "../context-meter";
import { thinkingLabel } from "../composer-utils";
import { askSideQuestion } from "../side-question-actions";

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
      apiForSession(chatId).compact(chatId, args || undefined).then(
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
    name: "btw",
    source: "builtin",
    description: "Ask a side question: answered now, the agent keeps working and doesn't see it",
    argsHint: "<question>",
    needsChat: true,
    requires: "sideQuestions",
    run: (args, ctx) => {
      if (!args.trim()) {
        notify("warning", "Type your question after /btw.");
        return false;
      }
      return askSideQuestion(requireChat(ctx), args);
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
      ctx.navigate(projectId ? routes.project(projectId) : routes.home(ctx.chatId ? envIdOfSession(ctx.chatId) : undefined));
      return true;
    },
  },
  {
    name: "name",
    source: "builtin",
    description: "Rename this chat (without a title: name it from the conversation)",
    argsHint: "[title]",
    needsChat: true,
    run: async (args, ctx) => {
      const chatId = requireChat(ctx);
      if (args) return renameFromSession(chatId, args);
      // I-074: the small model names it from the conversation; the server applies it like a
      // rename and pushes the new titles.
      const naming = showToast({ level: "info", message: "Naming this chat…", timeoutMs: 60_000 });
      try {
        const { title } = await apiForSession(chatId).generateSessionTitle(chatId);
        dismissToast(naming);
        notify("success", `Renamed to “${title}”`);
        return true;
      } catch (err) {
        dismissToast(naming);
        notify("error", `Could not name the chat: ${(err as Error).message}`);
        return false;
      }
    },
  },
  {
    name: "model",
    source: "builtin",
    requires: "models",
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
    requires: "models",
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
      const chatId = requireChat(ctx);
      const client = apiForSession(chatId);
      if (!isThisMachine(envIdOfSession(chatId))) {
        // A remote environment (I-123): the file is on the host; download it through the browser.
        try {
          const name = await downloadUrl(client.exportSessionDownloadUrl(chatId), "chat.html", client.authHeaders());
          notify("success", `Chat exported: ${name}`);
          return true;
        } catch (err) {
          notify("error", `Could not export: ${(err as Error).message}`);
          return false;
        }
      }
      try {
        const { path } = await client.exportSession(chatId);
        showToast({
          level: "success",
          title: "Chat exported",
          message: path,
          timeoutMs: 10_000,
          action: {
            label: "Reveal",
            onClick: () => void client.revealFile(path).catch((err: Error) => notify("error", `Could not reveal: ${err.message}`)),
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
  return BUILTIN_COMMANDS.filter((c) => (hasChat || !c.needsChat) && (!c.requires || !capabilities || hasCapability(capabilities, c.requires))).map(({ name, description, source, argsHint }) => ({
    name,
    source,
    ...(description ? { description } : {}),
    ...(argsHint ? { argsHint } : {}),
  }));
}

/** Optional capabilities default to off, except `models` (absent = true). */
function hasCapability(capabilities: HarnessCapabilities, name: keyof HarnessCapabilities): boolean {
  return name === "sideQuestions" ? capabilities[name] === true : capabilities[name] !== false;
}

export function findBuiltin(name: string): BuiltinCommand | undefined {
  return BUILTIN_COMMANDS.find((c) => c.name === name);
}
