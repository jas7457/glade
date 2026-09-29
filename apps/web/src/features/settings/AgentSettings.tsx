/**
 * Settings → Agents (`/settings/agent`, I-155): harness-independent settings (the agent new chats
 * use, sub-agents on/off, idle processes), then one card per agent this device knows about: pi,
 * the well-known ACP agents (Claude Code, Gemini CLI, Codex) and the ACP agents the user added.
 * Each card says whether the agent is installed here, has its Enable switch (only enabled +
 * installed agents are offered, to this device and to every device using it), its own settings
 * (pi's options, an ACP agent's command), and an install link when it's missing.
 *
 * The list comes from `GET /api/agent-catalog`; until it loads (or on an older server) it's
 * derived from the harness list and the ACP settings.
 */
import { useEffect, useState } from "preact/hooks";
import { Pencil, Trash2 } from "lucide-preact";
import { acpHarnessId, isAgentEnabled, type AgentCatalogEntry, type Settings } from "@glade/protocol";
import { FormGroup, FormRow, IconButton, Select, StatusDot, Switch } from "@/ui";
import {
  hostDefaultHarness as defaultHarness,
  hostDeviceName,
  hostEnvId,
  hostHarnesses as harnesses,
  hostSettings as settings,
  loadHostHarnesses,
  updateHostSettings as updateSettings,
} from "@/state/host-settings";
import { agentCatalogOf, loadAgentCatalog } from "@/state/agent-catalog";
import { agentSettingsKey } from "@/state/store";
import { AcpAgentDialog, AcpSettings, acpAgentConfig, joinArgs, removeAcpAgent } from "./AcpSettings";
import { CommitField } from "./CommitField";
import { PI_SETTINGS_FOOTER, PiSettingsRows } from "./PiSettings";

export { parseArgs } from "./PiSettings";

/** The catalog before `GET /api/agent-catalog` answers: the offered harnesses plus the user's ACP agents. */
export function fallbackCatalog(s: Settings, offered: readonly { id: string; label: string; isDefault: boolean }[] | null): AgentCatalogEntry[] {
  const out: AgentCatalogEntry[] = (offered ?? [{ id: "pi", label: "pi", isDefault: true }]).map((h) => ({
    id: h.id,
    label: h.label,
    kind: h.id.startsWith("acp-") ? "custom" : "builtin",
    command: h.id === "pi" ? s.harnesses.pi.piPath : null,
    installed: true,
    enabled: true,
    offered: true,
    isDefault: h.isDefault,
  }));
  for (const a of s.harnesses.acp?.agents ?? []) {
    const id = acpHarnessId(a.id);
    const known = out.find((e) => e.id === id);
    const entry = { kind: "custom" as const, command: joinArgs([a.command, ...a.args]), label: a.name };
    if (known) Object.assign(known, entry);
    else out.push({ id, ...entry, installed: true, enabled: isAgentEnabled(s, id), offered: isAgentEnabled(s, id), isDefault: false });
  }
  return out;
}

function statusOf(entry: AgentCatalogEntry, device: string): { tone: "on" | "off" | "error"; text: string } {
  if (!entry.installed) return { tone: "error", text: `Not found on ${device}` };
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
  const catalog = loaded?.length ? loaded : fallbackCatalog(s, offered);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const device = hostDeviceName.value;
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
        <FormRow label="Idle agents kept running" description="Idle chats beyond this are stopped; running chats never are." htmlFor="agent-idle">
          <CommitField
            id="agent-idle"
            type="number"
            class="w-[72px] text-right"
            value={String(a.maxIdleProcesses)}
            validate={(v) => (/^\d+$/.test(v.trim()) && Number(v) <= 64 ? null : "Enter a number from 0 to 64")}
            onCommit={(v) => void updateSettings({ agent: { maxIdleProcesses: Number(v) } })}
          />
        </FormRow>
      </FormGroup>

      {catalog.map((entry) => (
        <AgentCard key={entry.id} entry={entry} device={device} onEnable={(on) => void setEnabled(entry.id, on)} onEdit={() => setEditing(entry.id.slice("acp-".length))} />
      ))}

      <AcpSettings onAdd={() => setEditing("new")} count={s.harnesses.acp?.agents.length ?? 0} />
      <AcpAgentDialog
        open={editing !== null}
        agent={editing === "new" || editing === null ? null : (acpAgentConfig(editing) ?? null)}
        onOpenChange={(open) => !open && setEditing(null)}
      />
    </>
  );
}

interface AgentCardProps {
  entry: AgentCatalogEntry;
  device: string;
  onEnable: (enabled: boolean) => void;
  onEdit: () => void;
}

/** One agent: status, Enable switch, its settings, install link when missing. */
function AgentCard({ entry, device, onEnable, onEdit }: AgentCardProps) {
  const status = statusOf(entry, device);
  const custom = entry.kind === "custom";
  const pi = entry.id === "pi";
  return (
    <FormGroup
      title={entry.label}
      footer={pi ? PI_SETTINGS_FOOTER : undefined}
      actions={
        <>
          {custom && (
            <>
              <IconButton size="sm" label={`Edit ${entry.label}`} onClick={onEdit}>
                <Pencil size={13} />
              </IconButton>
              <IconButton size="sm" label={`Remove ${entry.label}`} onClick={() => void removeAcpAgent(entry.id.slice("acp-".length))}>
                <Trash2 size={13} />
              </IconButton>
            </>
          )}
        </>
      }
    >
      <FormRow
        label={
          <span class="inline-flex items-center gap-1.5">
            <StatusDot tone={status.tone} />
            {status.text}
          </span>
        }
        description={entry.command && !pi ? <span class="font-mono text-[0.9rem] [overflow-wrap:anywhere]">{entry.command}</span> : undefined}
      >
        <Switch aria-label={`Enable ${entry.label}`} checked={entry.enabled} onCheckedChange={onEnable} />
      </FormRow>
      {!entry.installed && (entry.installUrl || entry.installHint) && (
        <FormRow
          label="Install"
          description={entry.installHint ? <span class="font-mono text-[0.9rem] [overflow-wrap:anywhere]">{entry.installHint}</span> : undefined}
        >
          {entry.installUrl && (
            <a href={entry.installUrl} target="_blank" rel="noreferrer" class="text-accent hover:underline">
              Install instructions
            </a>
          )}
        </FormRow>
      )}
      {pi && <PiSettingsRows />}
    </FormGroup>
  );
}
