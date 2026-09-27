/**
 * The agent settings page (`/settings/agent`): harness-independent settings (sub-agents on/off,
 * idle processes, the harness new chats use when several are installed), then each installed
 * harness's own settings (I-066), then the ACP agents the user added (I-119). Until
 * `GET /api/harnesses` has loaded, every known harness panel is shown.
 */
import type { ComponentType } from "preact";
import { FormGroup, FormRow, Select, Switch } from "@/ui";
import { settings } from "@/state/store";
import { updateSettings } from "@/state/actions";
import { defaultHarness, harnesses } from "@/state/harnesses";
import { AcpSettings } from "./AcpSettings";
import { CommitField } from "./CommitField";
import { PiSettings } from "./PiSettings";

export { parseArgs } from "./PiSettings";

/** Settings panels by harness id. A harness without one has no settings of its own. */
const HARNESS_PANELS: Record<string, ComponentType<{ title?: string }>> = {
  pi: PiSettings,
};

export function AgentSettings() {
  const a = settings.value.agent;
  const installed = harnesses.value;
  const panels = installed
    ? installed.filter((h) => HARNESS_PANELS[h.id]).map((h) => ({ id: h.id, label: h.label }))
    : Object.keys(HARNESS_PANELS).map((id) => ({ id, label: id }));
  const several = (installed?.length ?? 0) > 1;
  return (
    <>
      <FormGroup>
        {several && (
          <FormRow label="New chats use" description="Existing chats keep the agent they were started with.">
            <Select
              aria-label="Agent for new chats"
              value={defaultHarness.value?.id ?? null}
              onChange={(defaultHarness) => void updateSettings({ agent: { defaultHarness } })}
              options={installed!.map((h) => ({ value: h.id, label: h.label }))}
            />
          </FormRow>
        )}
        <FormRow
          label="Use sub-agents"
          description="Let agents hand work to sub-agents in their own tabs. Applies to new chats and when a chat's agent restarts; sub-agents already running finish normally."
        >
          <Switch
            aria-label="Use sub-agents"
            checked={a.subagents}
            onCheckedChange={(subagents) => void updateSettings({ agent: { subagents } })}
          />
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
      {panels.map(({ id, label }) => {
        const Panel = HARNESS_PANELS[id]!;
        // One harness: the page is titled with its name already.
        return <Panel key={id} title={several ? label : undefined} />;
      })}
      <AcpSettings />
    </>
  );
}
