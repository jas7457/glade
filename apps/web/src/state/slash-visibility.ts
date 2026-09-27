/**
 * Which slash commands the menu shows (I-048). Hidden commands are stored in
 * `settings.slashCommands.hidden` as `<source>:<name>` keys; hiding only declutters the menu, a
 * hidden command typed in full still runs.
 */
import type { Settings, SlashCommand } from "@glade/protocol";

type CommandId = Pick<SlashCommand, "source" | "name">;

/** Stable settings key, e.g. `builtin:compact`, `extension:powerline`, `skill:skill:web-design`. */
export function slashCommandKey(command: CommandId): string {
  return `${command.source}:${command.name}`;
}

export function isSlashCommandHidden(settings: Pick<Settings, "slashCommands"> | null | undefined, command: CommandId): boolean {
  const hidden = settings?.slashCommands?.hidden;
  return !!hidden?.length && hidden.includes(slashCommandKey(command));
}

/** `hidden` with `keys` shown (`show`) or hidden, without duplicates. */
export function setSlashCommandsHidden(hidden: readonly string[], keys: readonly string[], hide: boolean): string[] {
  const next = new Set(hidden);
  for (const key of keys) {
    if (hide) next.add(key);
    else next.delete(key);
  }
  return [...next];
}
