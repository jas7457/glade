/**
 * Settings → Agents (`/settings/agent`, I-155, I-159, I-198): the Glade-wide settings (the agent new
 * chats use, sub-agents on/off, the quick-tasks model), then one row per agent this device can run:
 * pi, Claude Code (native since I-173, `claude` on the PATH) and Codex (I-177, `codex` on the PATH).
 * Each row says whether the agent was found here, has its Enable switch (only enabled + installed
 * agents are offered, to this device and to every device using it) and opens the agent's own page
 * (`/settings/agent/<id>`, `AgentPage`: version and update, defaults, models), with a dot when
 * a newer version is out. When the agent's command isn't on the PATH, the switch is off and
 * disabled, with the commands looked for. No install advice.
 *
 * Another device's Agents page (device switcher) is view only, but its agent pages open: checking
 * for and running updates works there.
 *
 * The list comes from `GET /api/agent-catalog`; until it loads (or on an older server) it's
 * derived from the harness list.
 */
import { useEffect } from "preact/hooks";
import { useNavigate } from "react-router";
import { builtinAgentCommand, isCustomAcpHarness, knownAcpAgentFor, type AgentCatalogEntry } from "@glade/protocol";
import { FormGroup, FormLinkRow, FormRow, Select, StatusDot, Switch } from "@glade/app-core/ui";
import { routes } from "@glade/app-core/app/routes";
import { cn } from "@glade/app-core/lib/cn";
import {
  hostDefaultHarness as defaultHarness,
  hostEnvId,
  hostHarnesses as harnesses,
  hostReadOnly,
  hostSettings as settings,
  loadHostHarnesses,
  updateHostSettings as updateSettings,
} from "@glade/app-core/state/host-settings";
import { agentCatalogOf, loadAgentCatalog } from "@glade/app-core/state/agent-catalog";
import { agentVersionOf, loadAgentVersions } from "@glade/app-core/state/agent-versions";
import { agentSettingsKey } from "@glade/app-core/state/store";
import { QuickTasksRow } from "./ModelSettings";

/** The catalog before `GET /api/agent-catalog` answers: the offered harnesses (never the user's own ACP agents). */
export function fallbackCatalog(offered: readonly { id: string; label: string; isDefault: boolean }[] | null): AgentCatalogEntry[] {
  return (offered ?? [{ id: "pi", label: "pi", isDefault: true }])
    .filter((h) => !isCustomAcpHarness(h.id))
    .map((h) => {
      const known = knownAcpAgentFor(h.id);
      const builtin = builtinAgentCommand(h.id);
      return {
        id: h.id,
        label: h.label,
        kind: known ? "known" : "builtin",
        command: builtin,
        lookedFor: known ? [...known.commands] : builtin ? [builtin] : [],
        installed: true,
        enabled: true,
        offered: true,
        isDefault: h.isDefault,
      };
    });
}

/** "`a`", "`a` or `b`", "`a`, `b` or `c`". */
function commandList(commands: readonly string[]) {
  const code = (c: string) => (
    <code key={c} class="font-mono text-[0.9rem]">
      {c}
    </code>
  );
  return commands.flatMap((c, i) => (i === 0 ? [code(c)] : [i === commands.length - 1 ? " or " : ", ", code(c)]));
}

function statusOf(entry: AgentCatalogEntry): { tone: "on" | "off" | "error"; text: string } {
  if (!entry.installed) return { tone: "error", text: "Not available" };
  if (!entry.enabled) return { tone: "off", text: "Installed, turned off" };
  return { tone: "on", text: entry.isDefault ? "Installed, used for new chats" : "Installed" };
}

/** The agent catalog of the edited device (loaded on mount; the harness list until then). */
export function useHostCatalog(): AgentCatalogEntry[] {
  const s = settings.value;
  const envId = hostEnvId();
  const key = agentSettingsKey(s);
  useEffect(() => void loadAgentCatalog(envId), [envId, key]);
  const loaded = agentCatalogOf(envId);
  return loaded?.length ? loaded : fallbackCatalog(harnesses.value);
}

/** Turn an agent on or off, then reload what depends on it. */
export async function setAgentEnabled(id: string, enabled: boolean): Promise<void> {
  const envId = hostEnvId();
  if (await updateSettings({ agents: { [id]: { enabled } } })) {
    await Promise.all([loadHostHarnesses(), loadAgentCatalog(envId)]);
  }
}

export function AgentSettings() {
  const navigate = useNavigate();
  const a = settings.value.agent;
  const offered = harnesses.value;
  const envId = hostEnvId();
  const readOnly = hostReadOnly.value;
  const catalog = useHostCatalog();
  const several = (offered?.length ?? 0) > 1;
  // Another device's versions are only known once asked (this Mac's are synced from the start).
  useEffect(() => {
    if (envId) void loadAgentVersions(envId);
  }, [envId]);

  return (
    <>
      <fieldset disabled={readOnly} class={cn("min-w-0", readOnly && "pointer-events-none")}>
        <FormGroup>
          {several && (
            <FormRow label="New chats use" description="Existing chats keep the agent they were started with.">
              <Select
                aria-label="Agent for new chats"
                value={defaultHarness.value?.id ?? null}
                onChange={(defaultHarness) => void updateSettings({ agent: { defaultHarness } })}
                options={offered!.map((h) => ({ value: h.id, label: h.label }))}
              />
            </FormRow>
          )}
          <FormRow
            label="Use sub-agents"
            description="Let agents hand work to sub-agents in their own tabs. Applies to new chats and when a chat's agent restarts; sub-agents already running finish normally."
          >
            <Switch aria-label="Use sub-agents" checked={a.subagents} onCheckedChange={(subagents) => void updateSettings({ agent: { subagents } })} />
          </FormRow>
          <QuickTasksRow />
        </FormGroup>
      </fieldset>

      <FormGroup title="Agents" footer="Each agent's version, default models and model list are on its own page.">
        {catalog.map((entry) => (
          <AgentRow
            key={entry.id}
            entry={entry}
            behind={agentVersionOf(envId, entry.id)?.state === "behind"}
            readOnly={readOnly}
            onOpen={() => navigate(routes.settingsAgent(entry.id))}
            onEnable={(on) => void setAgentEnabled(entry.id, on)}
          />
        ))}
      </FormGroup>
    </>
  );
}

/** What the agent's status line says under its name. */
export function agentDescription(entry: AgentCatalogEntry) {
  if (!entry.installed) {
    return entry.lookedFor.length ? <>Not found: looked for {commandList(entry.lookedFor)} on this device's PATH</> : "Not found on this device";
  }
  return entry.command ? <span class="font-mono text-[0.9rem] [overflow-wrap:anywhere]">{entry.command}</span> : undefined;
}

/** The status dot + text ("Installed, used for new chats"). */
export function AgentStatus({ entry }: { entry: AgentCatalogEntry }) {
  const status = statusOf(entry);
  return (
    <span class="inline-flex items-center gap-1.5">
      <StatusDot tone={status.tone} />
      {status.text}
    </span>
  );
}

/** The Enable switch (off and disabled when its command isn't found, or on another device). */
export function AgentEnableSwitch({ entry, readOnly, onEnable }: { entry: AgentCatalogEntry; readOnly?: boolean; onEnable: (enabled: boolean) => void }) {
  return (
    <Switch aria-label={`Enable ${entry.label}`} checked={entry.installed && entry.enabled} disabled={!entry.installed || readOnly} onCheckedChange={onEnable} />
  );
}

interface AgentRowProps {
  entry: AgentCatalogEntry;
  /** A newer version is available (I-198). */
  behind: boolean;
  readOnly: boolean;
  onOpen: () => void;
  onEnable: (enabled: boolean) => void;
}

/** One agent: name (+ update dot), status, Enable switch; opens its page. */
function AgentRow({ entry, behind, readOnly, onOpen, onEnable }: AgentRowProps) {
  const description = agentDescription(entry);
  return (
    <FormLinkRow
      aria-label={behind ? `${entry.label}, update available` : entry.label}
      label={
        <span class="inline-flex items-center gap-1.5 font-medium">
          {entry.label}
          {behind && <StatusDot tone="info" label="Update available" />}
        </span>
      }
      description={
        <>
          <AgentStatus entry={entry} />
          {description && <span class="block">{description}</span>}
        </>
      }
      accessory={<AgentEnableSwitch entry={entry} readOnly={readOnly} onEnable={onEnable} />}
      onSelect={onOpen}
    />
  );
}
