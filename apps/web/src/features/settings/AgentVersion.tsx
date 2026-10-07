/**
 * Settings → Agents → <agent> → Version (I-198): the installed version of an agent on the edited
 * device, the newest one ("2.1.293 available" / "Up to date" / "Couldn't check: …" / "Not
 * installed"), Check Now, and Update, which runs the agent's own updater there (its command in the
 * row's description). While it runs: a spinner and a collapsible log; while chats of that agent
 * are working: "Updates when N chats finish" + Cancel; afterwards "Updated to X" (the agent's
 * models are reloaded by the server) or the error and the log.
 *
 *   <AgentVersionGroup harness="claude" />
 *
 * Another Mac picked in the device switcher works too (paired devices may update its agents).
 * Opening the group asks for a check (the server reuses one from the last 10 minutes).
 */
import { useEffect, useState } from "preact/hooks";
import type { AgentUpdateJob, AgentVersionInfo } from "@glade/protocol";
import { Button, Disclosure, FormGroup, FormRow, Spinner, StatusDot } from "@glade/app-core/ui";
import { hostEnvId } from "@glade/app-core/state/host-settings";
import {
  agentUpdateError,
  agentVersionOf,
  agentVersionsChecking,
  agentVersionsError,
  agentVersionsKey,
  agentVersionsOf,
  cancelAgentUpdate,
  checkAgentVersions,
  loadAgentVersions,
  updateAgent,
  versionStatusText,
  waitingText,
  watchAgentVersions,
} from "@glade/app-core/state/agent-versions";

export function AgentVersionGroup({ harness }: { harness: string }) {
  const envId = hostEnvId();
  const key = agentVersionsKey(envId);
  useEffect(() => watchAgentVersions(), []);
  useEffect(() => {
    // What the server knows now (instant), then a check (reused when recent).
    if (!agentVersionsOf(envId)) void loadAgentVersions(envId);
    void checkAgentVersions(envId, false);
  }, [key]);

  const status = agentVersionsOf(envId);
  const info = agentVersionOf(envId, harness);
  const checking = agentVersionsChecking.value.has(key) || !!status?.checking;
  const fetchError = agentVersionsError.value.get(key) ?? null;
  const actionError = agentUpdateError(envId, harness);
  const line = versionStatusText(info, checking);
  const job = info?.update ?? null;

  return (
    <FormGroup title="Version" footer={footerText(info)}>
      <FormRow
        label={<span data-testid="agent-installed">{info?.installed ? `Installed ${info.installed}` : "Installed version"}</span>}
        description={
          <span class="flex items-center gap-1.5" data-testid="agent-version-status" data-state={info?.state ?? "unknown"}>
            <StatusDot tone={line.tone} />
            <span class="selectable">{line.text}</span>
          </span>
        }
      >
        <Button size="sm" disabled={checking} onClick={() => void checkAgentVersions(envId, true)}>
          {checking && <Spinner size={12} />}
          Check Now
        </Button>
      </FormRow>
      {fetchError && !info && <FormRow label={<span class="text-danger">{fetchError}</span>} />}
      {info && <UpdateRow envId={envId} info={info} job={job} />}
      {actionError && (
        <FormRow
          label={
            <span class="text-danger" data-testid="agent-update-action-error">
              {actionError}
            </span>
          }
        />
      )}
      {job && job.log.length > 0 && (job.state === "running" || job.state === "done" || job.state === "failed") && (
        <FormRow stacked label={<UpdateLog job={job} />} />
      )}
    </FormGroup>
  );
}

function UpdateRow({ envId, info, job }: { envId: string | undefined; info: AgentVersionInfo; job: AgentUpdateJob | null }) {
  const harness = info.harness;
  if (job?.state === "running") {
    return (
      <FormRow
        label={
          <span class="flex items-center gap-2" data-testid="agent-update-running">
            <Spinner size={12} />
            Updating…
          </span>
        }
        description={<Command command={job.command} />}
      />
    );
  }
  if (job?.state === "waiting") {
    return (
      <FormRow
        label={<span data-testid="agent-update-waiting">{waitingText(job.waitingFor)}</span>}
        description={
          <>
            Then runs <Command command={job.command} />. Open chats that are idle use the new version when they next start.
          </>
        }
      >
        <Button size="sm" onClick={() => void cancelAgentUpdate(envId, harness)}>
          Cancel
        </Button>
      </FormRow>
    );
  }
  if (!info.updateCommand || info.state === "not-installed") return null;
  const behind = info.state === "behind";
  return (
    <FormRow label={<span data-testid="agent-update-label">{updateLabel(job)}</span>} description={<UpdateDescription job={job} command={info.updateCommand} />}>
      <Button size="sm" variant={behind ? "primary" : "secondary"} onClick={() => void updateAgent(envId, harness)}>
        {job?.state === "failed" ? "Try Again" : "Update"}
      </Button>
    </FormRow>
  );
}

function updateLabel(job: AgentUpdateJob | null): string {
  if (job?.state === "done") return job.to ? (job.from && job.from === job.to ? `Already at ${job.to}` : `Updated to ${job.to}`) : "Updated";
  if (job?.state === "cancelled") return "Update cancelled";
  return "Update";
}

function UpdateDescription({ job, command }: { job: AgentUpdateJob | null; command: string }) {
  if (job?.state === "failed")
    return (
      <span class="text-danger" data-testid="agent-update-error">
        {job.error ?? "The update failed."}
      </span>
    );
  return (
    <>
      Runs <Command command={command} />. If chats of this agent are working, it waits until they finish.
    </>
  );
}

function Command({ command }: { command: string }) {
  return <code class="selectable font-mono text-[0.85rem]">{command}</code>;
}

function UpdateLog({ job }: { job: AgentUpdateJob }) {
  const failed = job.state === "failed";
  const [open, setOpen] = useState(failed);
  return (
    <Disclosure label={failed ? "Log (last lines)" : "Log"} open={open || failed} onOpenChange={setOpen} headerClass="-mx-1">
      <pre
        data-testid="agent-update-log"
        class="selectable mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-[5px] bg-control px-2 py-1 font-mono text-[0.85rem] text-fg shadow-[0_0_0_0.5px_var(--pi-separator)]"
      >
        {(failed ? job.log.slice(-60) : job.log).join("\n")}
      </pre>
    </Disclosure>
  );
}

/** "Newest version from npm, checked at 10:42." */
function footerText(info: AgentVersionInfo | null): string | undefined {
  if (!info?.checkedAt) return undefined;
  const time = new Date(info.checkedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return info.source ? `Newest version from ${info.source}, checked at ${time}.` : `Checked at ${time}.`;
}
