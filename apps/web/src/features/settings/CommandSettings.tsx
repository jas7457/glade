/**
 * Settings → Slash Commands (I-048): show or hide each command in the composer's slash menu,
 * grouped by source (I-155: Glade's, the agent's own, project folders).
 * Hiding only declutters: a hidden command typed in full still runs. Stored as
 * `settings.slashCommands.hidden` (`<source>:<name>` keys, see state/slash-visibility.ts).
 */
import { useEffect, useState } from "preact/hooks";
import { RefreshCw, Search } from "lucide-preact";
import { builtinCommands } from "@/features/chat/slash/builtins";
import { listFolderCommands } from "@/lib/api-folder";
import { Button, FormGroup, FormRow, Spinner, Switch, TextField } from "@/ui";
import {
  hostDefaultHarness,
  hostEnvId,
  hostHarnesses,
  hostProjects as projects,
  hostSettings as settings,
  updateHostSettings as updateSettings,
} from "@/state/host-settings";
import { requestFor } from "@/state/env-api";
import { setSlashCommandsHidden } from "@/state/slash-visibility";
import { listSlashCommands, type FolderCommands } from "./slash-command-list";

type Load = { status: "loading" } | { status: "done"; folders: FolderCommands[]; failed: number };

async function loadFolders(refresh: boolean): Promise<Load> {
  const targets: Array<{ id: string | null; name: string | null }> = [{ id: null, name: null }, ...projects.value.map((p) => ({ id: p.id, name: p.name }))];
  const results = await Promise.allSettled(targets.map((t) => listFolderCommands(t.id, refresh, requestFor(hostEnvId()))));
  const folders: FolderCommands[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") folders.push({ projectName: targets[i]!.name, commands: r.value });
  });
  return { status: "done", folders, failed: results.length - folders.length };
}

export function CommandSettings() {
  const hidden = settings.value.slashCommands?.hidden ?? [];
  const hiddenSet = new Set(hidden);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [query, setQuery] = useState("");

  const reload = (refresh: boolean) => {
    setLoad({ status: "loading" });
    void loadFolders(refresh).then(setLoad);
  };
  useEffect(() => reload(false), []);

  const setHidden = (keys: string[], hide: boolean) =>
    void updateSettings({ slashCommands: { hidden: setSlashCommandsHidden(settings.value.slashCommands?.hidden ?? [], keys, hide) } });

  // Folder commands come from the device's default agent; other agents' commands show in their chats.
  const agent = hostDefaultHarness.value;
  const groups = listSlashCommands(builtinCommands(true), load.status === "done" ? load.folders : [], query, agent?.label ?? "Agent");
  const inChatOnly = (hostHarnesses.value ?? []).filter((h) => h.id !== agent?.id && h.capabilities.commands);

  return (
    <>
      <p class="mb-4 text-fg-muted">
        Choose which commands appear when you type <span class="font-mono">/</span> in the composer. Hidden commands still run when you type
        their full name.
      </p>
      <div class="mb-5 flex items-center gap-2">
        <TextField
          aria-label="Filter commands"
          placeholder="Filter commands"
          leadingIcon={<Search />}
          value={query}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <Button size="sm" onClick={() => reload(true)} disabled={load.status === "loading"}>
          {load.status === "loading" ? <Spinner size={12} /> : <RefreshCw size={12} />}
          Refresh
        </Button>
      </div>
      {load.status === "done" && load.failed > 0 && (
        <p class="mb-4 text-[0.92rem] text-fg-muted">Some folders couldn't be read; their commands may be missing.</p>
      )}
      {groups.length === 0 && (
        <FormGroup>
          <FormRow label={<span class="text-fg-muted">{query ? "No matching commands." : "No commands found."}</span>} />
        </FormGroup>
      )}
      {groups.map((group) => {
        const keys = group.commands.map((c) => c.key);
        const allShown = keys.every((k) => !hiddenSet.has(k));
        const allHidden = keys.every((k) => hiddenSet.has(k));
        return (
          <FormGroup
            key={group.id}
            title={group.label}
            actions={
              <>
                <Button size="sm" variant="ghost" disabled={allShown} onClick={() => setHidden(keys, false)} aria-label={`Show all ${group.label}`}>
                  Show All
                </Button>
                <Button size="sm" variant="ghost" disabled={allHidden} onClick={() => setHidden(keys, true)} aria-label={`Hide all ${group.label}`}>
                  Hide All
                </Button>
              </>
            }
          >
            {group.commands.map(({ key, command, projects: only }) => (
              <FormRow
                key={key}
                label={
                  <span class="font-mono text-[0.95rem]">
                    /{command.name}
                    {command.argsHint && <span class="ml-1.5 text-fg-subtle">{command.argsHint}</span>}
                  </span>
                }
                description={
                  command.description || only ? (
                    <>
                      {command.description}
                      {only && <span class="block text-fg-subtle">Only in {only.join(", ")}</span>}
                    </>
                  ) : undefined
                }
              >
                <Switch size="sm" aria-label={`Show /${command.name}`} checked={!hiddenSet.has(key)} onCheckedChange={(show) => setHidden([key], !show)} />
              </FormRow>
            ))}
          </FormGroup>
        );
      })}
      {inChatOnly.length > 0 && (
        <p class="text-[0.92rem] text-fg-muted">
          {inChatOnly.map((h) => h.label).join(", ")} {inChatOnly.length === 1 ? "offers its" : "offer their"} own commands in {inChatOnly.length === 1 ? "its" : "their"} chats.
        </p>
      )}
    </>
  );
}
