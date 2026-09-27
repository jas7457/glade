/**
 * The list behind Settings → Slash Commands (I-048): Glade's built-ins plus the union of the
 * harness commands of the scratch folder and every project. Commands missing from the scratch
 * folder are project-specific (project skills/prompts) and list the projects that have them.
 * Pure, for tests.
 */
import type { SlashCommand, SlashCommandSource } from "@glade/protocol";
import { GROUP_LABELS, GROUP_ORDER, compareCommandNames } from "@/features/chat/slash/match";
import { slashCommandKey } from "@/state/slash-visibility";

export interface ListedCommand {
  key: string;
  command: SlashCommand;
  /** Project names when the command only exists in some projects; `null` = everywhere. */
  projects: string[] | null;
}

export interface ListedGroup {
  source: SlashCommandSource;
  label: string;
  commands: ListedCommand[];
}

export interface FolderCommands {
  /** `null` = the scratch folder (standalone chats). */
  projectName: string | null;
  commands: readonly SlashCommand[];
}

export function listSlashCommands(builtins: readonly SlashCommand[], folders: readonly FolderCommands[], query = ""): ListedGroup[] {
  const byKey = new Map<string, { command: SlashCommand; projects: Set<string>; global: boolean }>();
  const builtinNames = new Set(builtins.map((c) => c.name));
  for (const command of builtins) byKey.set(slashCommandKey(command), { command, projects: new Set(), global: true });
  for (const folder of folders) {
    for (const command of folder.commands) {
      // A harness command named like a built-in never shows in the menu (the built-in wins).
      if (builtinNames.has(command.name)) continue;
      const key = slashCommandKey(command);
      const entry = byKey.get(key) ?? { command, projects: new Set<string>(), global: false };
      if (folder.projectName === null) entry.global = true;
      else entry.projects.add(folder.projectName);
      byKey.set(key, entry);
    }
  }
  const q = query.trim().toLowerCase();
  const matches = (c: SlashCommand) => !q || c.name.toLowerCase().includes(q) || !!c.description?.toLowerCase().includes(q);
  return GROUP_ORDER.map((source) => ({
    source,
    label: GROUP_LABELS[source],
    commands: [...byKey.entries()]
      .filter(([, e]) => e.command.source === source && matches(e.command))
      .sort(([, a], [, b]) => compareCommandNames(a.command, b.command))
      .map(([key, e]) => ({ key, command: e.command, projects: e.global ? null : [...e.projects].sort((a, b) => a.localeCompare(b)) })),
  })).filter((g) => g.commands.length > 0);
}
