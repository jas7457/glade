/**
 * The ⌘K command palette: jump to chats and projects and run app actions by name. Commands come
 * from the app registry (`app/commands.tsx`), ranking from `match.ts`, the panel from
 * `ui/CommandPalette`. Mounted once in the app layout; open state is `paletteOpen` (state/ui).
 */
import { useState } from "preact/hooks";
import { CommandPalette, type CommandPaletteSection } from "@/ui";
import { COMMAND_GROUPS, isAvailable, type Command, type CommandContext, type CommandPrompt, buildCommands } from "@/app/commands";
import { paletteOpen } from "@/state/ui";
import { rankItems } from "./match";

/** Rows per group when the query is empty (Actions without a query are the common ones). */
const EMPTY_LIMIT = { Chats: 8, Projects: 5 };

export function paletteSections(commands: readonly Command[], query: string): CommandPaletteSection[] {
  return rankItems(commands.filter(isAvailable), query, { groupOrder: COMMAND_GROUPS, emptyLimit: EMPTY_LIMIT, limit: 8 }).map(({ group, items }) => ({
    title: group,
    items: items.map(({ item, indices }) => ({
      id: item.id,
      title: item.title,
      subtitle: item.subtitle,
      icon: item.icon,
      shortcut: item.shortcut,
      highlights: indices,
    })),
  }));
}

export interface PaletteProps {
  context: Omit<CommandContext, "togglePalette">;
}

export function Palette({ context }: PaletteProps) {
  // Mounted only while open, so every opening starts with an empty query.
  return paletteOpen.value ? <PalettePanel context={context} /> : null;
}

function PalettePanel({ context }: PaletteProps) {
  const [query, setQuery] = useState("");
  const [prompt, setPrompt] = useState<CommandPrompt | null>(null);

  const setOpen = (next: boolean) => {
    paletteOpen.value = next;
  };

  const commands = buildCommands({ ...context, togglePalette: () => setOpen(!paletteOpen.value) });
  const run = (id: string) => {
    const command = commands.find((c) => c.id === id);
    if (!command) return;
    const next = command.prompt?.();
    if (next) {
      setPrompt(next);
      setQuery(next.initial);
      return;
    }
    setOpen(false);
    // After the palette has closed and handed focus back, so dialogs opened by the command
    // (e.g. the delete confirmation) own the focus.
    setTimeout(() => void command.run(), 0);
  };

  return (
    <CommandPalette
      open
      onOpenChange={setOpen}
      query={query}
      onQueryChange={setQuery}
      sections={prompt ? [] : paletteSections(commands, query)}
      onRun={run}
      placeholder={prompt ? prompt.placeholder : "Search chats, projects and actions…"}
      badge={prompt?.title}
      onSubmit={
        prompt
          ? (value) => {
              void prompt.submit(value);
              setOpen(false);
            }
          : undefined
      }
    />
  );
}
