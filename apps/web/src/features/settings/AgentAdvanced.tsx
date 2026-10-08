/**
 * Settings → Agents → <agent> → Advanced (I-201): a custom command for pi, Claude Code or Codex,
 * e.g. a work setup that must start pi through a wrapper (`mywrapper pi --offline`).
 *
 * - The **Advanced** switch is off by default and the command field is hidden while it's off.
 *   Off means Glade's own command (`pi`, `claude`, `codex`), always; a saved command stays and is
 *   used again when Advanced is switched back on (`Settings.agents.<id>.advanced` + `command`).
 * - The field commits on Enter or blur; a command the server would refuse (open quote, shell
 *   syntax, one of Glade's own flags) shows why under the field and isn't saved
 *   (`agentCommandError`, the same check as the server's).
 * - **Test** runs `<command> --version` on the device (what's in the field, saved or not) and
 *   shows the version or why it failed.
 * - On another device (device switcher) it's view only, like the agent's other settings.
 */
import { useEffect, useState } from "preact/hooks";
import { agentCommandError, builtinAgentCommand, type AgentCatalogEntry, type AgentCommandTestResult } from "@glade/protocol";
import { Button, FormGroup, FormRow, Spinner, StatusDot, Switch, TextField } from "@glade/app-core/ui";
import { request } from "@glade/app-core/lib/api";
import { loadAgentCatalog } from "@glade/app-core/state/agent-catalog";
import { requestFor } from "@glade/app-core/state/env-api";
import { hostDeviceName, hostEnvId, hostReadOnly, hostSettings, loadHostHarnesses, updateHostSettings } from "@glade/app-core/state/host-settings";

/** Save part of the agent's switches, then reload what depends on its command (installed, offered). */
async function saveAgentCommand(id: string, patch: { advanced?: boolean; command?: string | null }): Promise<boolean> {
  const envId = hostEnvId();
  const ok = await updateHostSettings({ agents: { [id]: patch } });
  if (ok) await Promise.all([loadHostHarnesses(), loadAgentCatalog(envId)]);
  return ok;
}

type TestState = { running: true } | { running: false; result: AgentCommandTestResult } | null;

export function AgentAdvancedGroup({ entry }: { entry: AgentCatalogEntry }) {
  const builtin = builtinAgentCommand(entry.id);
  const readOnly = hostReadOnly.value;
  const own = hostSettings.value.agents?.[entry.id];
  const advanced = own?.advanced === true;
  const saved = own?.command ?? "";
  const [draft, setDraft] = useState(saved);
  const [test, setTest] = useState<TestState>(null);
  useEffect(() => setDraft(saved), [saved]);
  if (!builtin) return null;

  const error = agentCommandError(entry.id, draft);
  const fieldId = `agent-command-${entry.id}`;
  const commit = (value: string) => {
    if (agentCommandError(entry.id, value)) return;
    const next = value.trim();
    if (next !== saved) void saveAgentCommand(entry.id, { command: next || null });
  };
  const runTest = async () => {
    setTest({ running: true });
    try {
      const result = await (requestFor(hostEnvId()) ?? request)<AgentCommandTestResult>("POST", "/agent-command/test", { harness: entry.id, command: draft });
      setTest({ running: false, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTest({ running: false, result: { ok: false, command: `${draft.trim() || builtin} --version`, version: null, output: "", error: message } });
    }
  };

  return (
    <fieldset disabled={readOnly} class="min-w-0">
      <FormGroup footer={readOnly ? `View only. Change this on ${hostDeviceName.value}.` : undefined}>
        <FormRow label="Advanced" description={`Run ${entry.label} with a command of your own, e.g. through a wrapper. Off: Glade runs ${builtin}.`}>
          <Switch
            aria-label={`Advanced settings for ${entry.label}`}
            checked={advanced}
            disabled={readOnly}
            onCheckedChange={(on) => void saveAgentCommand(entry.id, { advanced: on })}
          />
        </FormRow>
        {advanced && (
          <FormRow
            stacked
            label="Command"
            htmlFor={fieldId}
            description={
              <>
                Glade adds its own arguments after it. A wrapper must pass the arguments through and leave stdin and stdout alone (logging to stderr is fine), e.g. end
                with <code class="font-mono text-[0.9rem]">exec {builtin} "$@"</code>. There's no shell: quotes work, $VARIABLES and ~ aren't expanded. Applies to chats
                started afterwards; empty means <code class="font-mono text-[0.9rem]">{builtin}</code>.
              </>
            }
          >
            <div class="flex w-full flex-col gap-1.5">
              <div class="flex items-center gap-2">
                <TextField
                  id={fieldId}
                  mono
                  class="min-w-0 flex-1"
                  placeholder={builtin}
                  value={draft}
                  disabled={readOnly}
                  invalid={!!error}
                  aria-describedby={error ? `${fieldId}-error` : undefined}
                  onInput={(e) => setDraft(e.currentTarget.value)}
                  onBlur={(e) => commit(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commit(e.currentTarget.value);
                    if (e.key === "Escape") setDraft(saved);
                  }}
                />
                <Button size="sm" disabled={readOnly || !!error || test?.running === true} onClick={() => void runTest()}>
                  {test?.running && <Spinner size={12} />}
                  Test
                </Button>
              </div>
              {error && (
                <span id={`${fieldId}-error`} role="alert" class="text-[0.92rem] text-danger">
                  {error}
                </span>
              )}
              {test && !test.running && <TestResult result={test.result} />}
            </div>
          </FormRow>
        )}
      </FormGroup>
    </fieldset>
  );
}

function TestResult({ result }: { result: AgentCommandTestResult }) {
  return (
    <div class="flex flex-col gap-1 text-[0.92rem]" data-testid="agent-command-test" data-ok={result.ok}>
      <span class="flex items-center gap-1.5">
        <StatusDot tone={result.ok ? "on" : "error"} />
        <span class={result.ok ? "text-fg" : "text-danger"}>{result.ok ? `Works: ${result.version}` : result.error}</span>
      </span>
      <code class="selectable font-mono text-[0.88rem] text-fg-muted [overflow-wrap:anywhere]">$ {result.command}</code>
      {result.output && !result.ok && <pre class="selectable max-h-32 overflow-auto font-mono text-[0.85rem] whitespace-pre-wrap text-fg-muted">{result.output}</pre>}
    </div>
  );
}
