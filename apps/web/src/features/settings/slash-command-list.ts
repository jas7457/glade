/**
 * The list behind Settings → Slash Commands (I-048): Glade's built-ins plus the union of the
 * harness commands of the scratch folder and every project. Commands missing from the scratch
 * folder are project-specific (project skills/prompts) and list the projects that have them.
 * Grouped by source (I-155): "Glade" (built-ins), the agent's own ("pi · Extensions", …), then
 * "Project folders". Pure, for tests.
 */
import type { SlashCommand } from "@glade/protocol";
import { GROUP_LABELS, GROUP_ORDER, compareCommandNames } from "@glade/app-core/features/chat/slash/match";
import { slashCommandKey } from "@glade/app-core/state/slash-visibility";

export interface ListedCommand {
  key: string;
  command: SlashCommand;
  /** Project names when the command only exists in some projects; `null` = everywhere. */
  projects: string[] | null;
}

export interface ListedGroup {
  /** Stable key: `glade`, `agent-<source>` or `projects`. */
  id: string;
  label: string;
  commands: ListedCommand[];
}

export interface FolderCommands {
  /** `null` = the scratch folder (standalone chats). */
  projectName: string | null;
  commands: readonly SlashCommand[];
}

export function listSlashCommands(builtins: readonly SlashCommand[], folders: readonly FolderCommands[], query = "", agent = "Agent"): ListedGroup[] {
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
  const sourceOrder = (c: SlashCommand) => GROUP_ORDER.indexOf(c.source);
  const listed = [...byKey.entries()]
    .filter(([, e]) => matches(e.command))
    .sort(([, a], [, b]) => sourceOrder(a.command) - sourceOrder(b.command) || compareCommandNames(a.command, b.command))
    .map(([key, e]) => ({ key, command: e.command, projects: e.global ? null : [...e.projects].sort((a, b) => a.localeCompare(b)) }));
  const groups: ListedGroup[] = [{ id: "glade", label: "Glade", commands: listed.filter((c) => c.command.source === "builtin") }];
  for (const source of GROUP_ORDER) {
    if (source === "builtin") continue;
    groups.push({ id: `agent-${source}`, label: `${agent} · ${GROUP_LABELS[source]}`, commands: listed.filter((c) => c.command.source === source && c.projects === null) });
  }
  groups.push({ id: "projects", label: "Project folders", commands: listed.filter((c) => c.command.source !== "builtin" && c.projects !== null) });
  return groups.filter((g) => g.commands.length > 0);
}
