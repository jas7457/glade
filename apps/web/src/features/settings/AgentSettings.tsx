import { FormGroup, FormRow, Switch } from "@/ui";
import { settings } from "@/state/store";
import { updateSettings } from "@/state/actions";
import { CommitField } from "./CommitField";

/** Split an argument string on whitespace (no quoting support). */
export function parseArgs(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

export function AgentSettings() {
  const a = settings.value.agent;
  return (
    <FormGroup footer="Changes apply to newly started chats. Chats that are already open keep their current agent process until it's restarted.">
      <FormRow label="pi executable" description="Path to pi, or just “pi” to find it on your PATH." htmlFor="pi-path">
        <CommitField
          id="pi-path"
          mono
          class="w-[240px]"
          value={a.piPath}
          validate={(v) => (v.trim() ? null : "Required")}
          onCommit={(piPath) => void updateSettings({ agent: { piPath: piPath.trim() } })}
        />
      </FormRow>
      <FormRow label="Extra arguments" description="Passed to every pi process, separated by spaces." htmlFor="pi-args">
        <CommitField
          id="pi-args"
          mono
          class="w-[240px]"
          placeholder="--no-skills"
          value={a.extraArgs.join(" ")}
          onCommit={(text) => void updateSettings({ agent: { extraArgs: parseArgs(text) } })}
        />
      </FormRow>
      <FormRow label="Idle agents kept running" description="Idle chats beyond this are stopped; running chats never are." htmlFor="pi-idle">
        <CommitField
          id="pi-idle"
          type="number"
          class="w-[72px] text-right"
          value={String(a.maxIdleProcesses)}
          validate={(v) => (/^\d+$/.test(v.trim()) && Number(v) <= 64 ? null : "Enter a number from 0 to 64")}
          onCommit={(v) => void updateSettings({ agent: { maxIdleProcesses: Number(v) } })}
        />
      </FormRow>
      <FormRow label="Auto-compaction" description="Summarise old context automatically when the context window fills up.">
        <Switch aria-label="Auto-compaction" checked={a.autoCompaction} onCheckedChange={(autoCompaction) => void updateSettings({ agent: { autoCompaction } })} />
      </FormRow>
      <FormRow label="Auto-retry" description="Retry automatically after transient provider errors.">
        <Switch aria-label="Auto-retry" checked={a.autoRetry} onCheckedChange={(autoRetry) => void updateSettings({ agent: { autoRetry } })} />
      </FormRow>
    </FormGroup>
  );
}
