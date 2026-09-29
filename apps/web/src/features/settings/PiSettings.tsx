/**
 * pi's own settings (`Settings.harnesses.pi`, I-066), shown in pi's card on the Agents page
 * (I-155). `PiSettingsRows` are the rows alone (inside that card); `PiSettings` wraps them in a group.
 */
import { FormGroup, FormRow, Switch } from "@/ui";
import { hostSettings as settings, updateHostSettings as updateSettings } from "@/state/host-settings";
import type { PiHarnessSettings } from "@glade/protocol";
import { CommitField } from "./CommitField";

/** Split an argument string on whitespace (no quoting support). */
export function parseArgs(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

const save = (pi: Partial<PiHarnessSettings>) => void updateSettings({ harnesses: { pi } });

export const PI_SETTINGS_FOOTER = "Changes apply to newly started chats. Chats that are already open keep their current agent process until it's restarted.";

export function PiSettings({ title }: { title?: string }) {
  return (
    <FormGroup title={title} footer={PI_SETTINGS_FOOTER}>
      <PiSettingsRows />
    </FormGroup>
  );
}

export function PiSettingsRows() {
  const pi = settings.value.harnesses.pi;
  return (
    <>
      <FormRow label="pi executable" description="Path to pi, or just “pi” to find it on your PATH." htmlFor="pi-path">
        <CommitField
          id="pi-path"
          mono
          class="w-[240px]"
          value={pi.piPath}
          validate={(v) => (v.trim() ? null : "Required")}
          onCommit={(piPath) => save({ piPath: piPath.trim() })}
        />
      </FormRow>
      <FormRow label="Extra arguments" description="Passed to every pi process, separated by spaces." htmlFor="pi-args">
        <CommitField
          id="pi-args"
          mono
          class="w-[240px]"
          placeholder="--no-skills"
          value={pi.extraArgs.join(" ")}
          onCommit={(text) => save({ extraArgs: parseArgs(text) })}
        />
      </FormRow>
      <FormRow label="Auto-compaction" description="Summarise old context automatically when the context window fills up.">
        <Switch aria-label="Auto-compaction" checked={pi.autoCompaction} onCheckedChange={(autoCompaction) => save({ autoCompaction })} />
      </FormRow>
      <FormRow label="Auto-retry" description="Retry automatically after transient provider errors.">
        <Switch aria-label="Auto-retry" checked={pi.autoRetry} onCheckedChange={(autoRetry) => save({ autoRetry })} />
      </FormRow>
    </>
  );
}
