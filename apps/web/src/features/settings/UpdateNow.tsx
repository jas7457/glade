/**
 * Settings → General → Glade in the Mac app (I-154, I-160): Update Now when a newer Glade is on main,
 * the job's steps with their live state, Cancel (before the install step), a collapsible log and
 * the reason when it refused or failed. Once installed: "Restart Glade to finish", which asks
 * first when chats are working ("Restart When Chats Finish" / "Restart Now").
 */
import { useState } from "preact/hooks";
import { Check, Circle, Minus, RotateCw, X } from "lucide-preact";
import type { UpdateJobStatus, UpdateStep } from "@glade/protocol";
import { Button, Disclosure, FormRow, Spinner } from "@glade/app-core/ui";
import {
  busyChats,
  cancelRestartWait,
  cancelUpdate,
  restartChoice,
  restartNow,
  restartWaiting,
  restartWhenIdle,
  startUpdate,
  updateActionError,
} from "@/state/update";

const chats = (n: number) => `${n} chat${n === 1 ? "" : "s"}`;

export function UpdateNow({ job, behind }: { job: UpdateJobStatus; behind: boolean }) {
  const actionError = updateActionError.value;
  const busy = job.state === "checking" || job.state === "running";
  const started = job.state !== "idle";
  return (
    <>
      {job.state === "installed" ? (
        <RestartRow />
      ) : busy ? (
        <FormRow label={job.state === "checking" ? "Checking the repo…" : "Updating Glade…"} description="Glade keeps working while it builds.">
          <Button size="sm" disabled={!job.canCancel} onClick={() => void cancelUpdate()}>
            Cancel
          </Button>
        </FormRow>
      ) : !behind && !started ? null : (
        // Up to date and nothing ran: the status row above already says so.
        <FormRow
          label={behind ? "A newer Glade is on main." : "Glade is up to date."}
          description={behind ? "Pulls main, installs dependencies and builds the app in the repo folder. It takes a few minutes." : undefined}
        >
          {behind && (
            <Button size="sm" variant="primary" onClick={() => void startUpdate()}>
              {job.state === "failed" || job.state === "cancelled" || job.state === "refused" ? "Try Again" : "Update Now"}
            </Button>
          )}
        </FormRow>
      )}
      {(job.error || actionError) && (
        <FormRow
          label={
            <span class="text-danger" data-testid="update-error">
              {job.state === "refused" ? `Can't update: ${job.error}` : (actionError ?? job.error)}
            </span>
          }
        />
      )}
      {started && job.state !== "refused" && (
        <FormRow stacked label="Steps">
          <ol class="flex w-full flex-col gap-1" data-testid="update-steps">
            {job.steps.map((step) => (
              <StepLine key={step.id} step={step} />
            ))}
          </ol>
        </FormRow>
      )}
      {started && job.log.length > 0 && <FormRow stacked label={<UpdateLog job={job} />} />}
    </>
  );
}

function StepLine({ step }: { step: UpdateStep }) {
  const icon =
    step.state === "running" ? (
      <Spinner size={12} />
    ) : step.state === "done" ? (
      <Check size={12} class="text-success" />
    ) : step.state === "failed" ? (
      <X size={12} class="text-danger" />
    ) : step.state === "cancelled" ? (
      <Minus size={12} class="text-fg-muted" />
    ) : (
      <Circle size={10} class="text-fg-subtle" />
    );
  return (
    <li class="flex items-center gap-2" data-state={step.state}>
      <span class="flex w-3 justify-center">{icon}</span>
      <span class={step.state === "pending" || step.state === "cancelled" ? "text-fg-muted" : "text-fg"}>{step.label}</span>
      <code class="selectable truncate font-mono text-[0.85rem] text-fg-subtle">{step.command}</code>
    </li>
  );
}

function UpdateLog({ job }: { job: UpdateJobStatus }) {
  const failed = job.state === "failed";
  const [open, setOpen] = useState(failed);
  return (
    <Disclosure label={failed ? "Log (last lines)" : "Log"} open={open || failed} onOpenChange={setOpen} headerClass="-mx-1">
      <pre
        data-testid="update-log"
        class="selectable mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-[5px] bg-control px-2 py-1 font-mono text-[0.85rem] text-fg shadow-[0_0_0_0.5px_var(--pi-separator)]"
      >
        {(failed ? job.log.slice(-60) : job.log).join("\n")}
      </pre>
    </Disclosure>
  );
}

/** "Restart Glade to finish", asking first when chats are working. */
function RestartRow() {
  const [asking, setAsking] = useState(false);
  const busy = busyChats.value;
  if (restartWaiting.value) {
    return (
      <FormRow label="Restarting when chats finish…" description={busy > 0 ? `${chats(busy)} still working.` : "Restarting…"}>
        <Button size="sm" onClick={() => cancelRestartWait()}>
          Don't Wait
        </Button>
        <Button size="sm" onClick={() => void restartNow()}>
          Restart Now
        </Button>
      </FormRow>
    );
  }
  if (asking && busy > 0) {
    return (
      <FormRow label={`${chats(busy)} ${busy === 1 ? "is" : "are"} still working.`} description="Restarting now stops them (you can continue them afterwards).">
        <Button size="sm" onClick={() => setAsking(false)}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void restartNow()}>
          Restart Now
        </Button>
        <Button size="sm" variant="primary" onClick={() => restartWhenIdle()}>
          Restart When Chats Finish
        </Button>
      </FormRow>
    );
  }
  return (
    <FormRow label="Restart Glade to finish" description="The new version is installed. Glade reopens where you are.">
      <Button
        size="sm"
        variant="primary"
        onClick={() => {
          if (restartChoice(busy) === "ask") setAsking(true);
          else void restartNow();
        }}
      >
        <RotateCw size={12} />
        Restart Glade
      </Button>
    </FormRow>
  );
}
