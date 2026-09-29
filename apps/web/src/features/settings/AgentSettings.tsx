/**
 * Settings → Agents (`/settings/agent`, I-155, I-159): harness-independent settings (the agent new
 * chats use, sub-agents on/off), then one card per agent this device can run: pi and Claude Code.
 * Each card says whether the agent was found here and has its Enable switch (only enabled +
 * installed agents are offered, to this device and to every device using it). When the agent's
 * command isn't on the PATH, the switch is off and disabled, with the commands looked for.
 * No install advice, no per-agent options (pi is always `pi` on the PATH, I-159).
 *
 * The list comes from `GET /api/agent-catalog`; until it loads (or on an older server) it's
 * derived from the harness list.
 */
import { useEffect } from "preact/hooks";
import { PI_COMMAND, isCustomAcpHarness, knownAcpAgentFor, type AgentCatalogEntry } from "@glade/protocol";
import { FormGroup, FormRow, Select, StatusDot, Switch } from "@/ui";
import {
  hostDefaultHarness as defaultHarness,
  hostEnvId,
  hostHarnesses as harnesses,
  hostSettings as settings,
  loadHostHarnesses,
  updateHostSettings as updateSettings,
} from "@/state/host-settings";
import { agentCatalogOf, loadAgentCatalog } from "@/state/agent-catalog";
import { agentSettingsKey } from "@/state/store";

/** The catalog before `GET /api/agent-catalog` answers: the offered harnesses (never the user's own ACP agents). */
export function fallbackCatalog(offered: readonly { id: string; label: string; isDefault: boolean }[] | null): AgentCatalogEntry[] {
  return (offered ?? [{ id: "pi", label: "pi", isDefault: true }])
    .filter((h) => !isCustomAcpHarness(h.id))
    .map((h) => {
      const known = knownAcpAgentFor(h.id);
      const pi = h.id === "pi";
      return {
        id: h.id,
        label: h.label,
        kind: known ? "known" : "builtin",
        command: pi ? PI_COMMAND : null,
        lookedFor: known ? [...known.commands] : pi ? [PI_COMMAND] : [],
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

export function AgentSettings() {
  const s = settings.value;
  const a = s.agent;
  const offered = harnesses.value;
  const envId = hostEnvId();
  const key = agentSettingsKey(s);
  useEffect(() => void loadAgentCatalog(envId), [envId, key]);
  const loaded = agentCatalogOf(envId);
  const catalog = loaded?.length ? loaded : fallbackCatalog(offered);
  const several = (offered?.length ?? 0) > 1;

  const setEnabled = async (id: string, enabled: boolean) => {
    if (await updateSettings({ agents: { [id]: { enabled } } })) {
      await Promise.all([loadHostHarnesses(), loadAgentCatalog(envId)]);
    }
  };

  return (
    <>
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
      </FormGroup>

      {catalog.map((entry) => (
        <AgentCard key={entry.id} entry={entry} onEnable={(on) => void setEnabled(entry.id, on)} />
      ))}
    </>
  );
}

interface AgentCardProps {
  entry: AgentCatalogEntry;
  onEnable: (enabled: boolean) => void;
}

/** One agent: status and Enable switch (off and disabled when its command isn't found). */
function AgentCard({ entry, onEnable }: AgentCardProps) {
  const status = statusOf(entry);
  const description = !entry.installed ? (
    entry.lookedFor.length ? (
      <>Not found: looked for {commandList(entry.lookedFor)} on this device's PATH</>
    ) : (
      "Not found on this device"
    )
  ) : entry.command ? (
    <span class="font-mono text-[0.9rem] [overflow-wrap:anywhere]">{entry.command}</span>
  ) : undefined;
  return (
    <FormGroup title={entry.label}>
      <FormRow
        label={
          <span class="inline-flex items-center gap-1.5">
            <StatusDot tone={status.tone} />
            {status.text}
          </span>
        }
        description={description}
      >
        <Switch aria-label={`Enable ${entry.label}`} checked={entry.installed && entry.enabled} disabled={!entry.installed} onCheckedChange={onEnable} />
      </FormRow>
    </FormGroup>
  );
}
