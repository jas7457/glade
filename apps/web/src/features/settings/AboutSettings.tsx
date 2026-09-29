/**
 * Settings → About (I-149): which commit this Glade was built from, whether origin's main has
 * moved on ("Up to date" / "N commits behind main" / "Update available" / "Couldn't check",
 * with Check Now), and the command to update. There's no Update button (F-024).
 */
import { useEffect, useState } from "preact/hooks";
import { Check, Copy, RefreshCw } from "lucide-preact";
import { UPDATE_COMMAND } from "@glade/protocol";
import { Button, FormGroup, FormRow, Spinner, StatusDot } from "@/ui";
import { buildLine, checkText, checkVersionNow, loadVersion, versionChecking, versionError, versionStatus } from "@/state/version";

export function AboutSettings() {
  useEffect(() => void loadVersion(), []);
  const status = versionStatus.value;
  const build = status?.build ?? null;
  const checking = versionChecking.value || !!status?.checking;
  const line = checkText(status);
  const error = versionError.value;
  const behind = status?.check?.state === "behind" || status?.check?.state === "update-available";

  return (
    <>
      <FormGroup title="Glade">
        <FormRow
          label={<span data-testid="build-line">{build ? buildLine(build) : status ? "Unknown build" : "Loading…"}</span>}
          description={
            build && (
              <span class="selectable">
                {build.dirty ? "With local changes (not committed). " : ""}
                {build.repoPath ? `From ${build.repoPath}` : ""}
              </span>
            )
          }
        />
        <FormRow
          label={
            <span class="flex items-center gap-2" data-testid="version-status">
              <StatusDot tone={line.tone} />
              {line.text}
            </span>
          }
          description={error ? <span class="text-danger">{error}</span> : line.detail}
        >
          <Button size="sm" disabled={checking || !status} onClick={() => void checkVersionNow()}>
            {checking ? <Spinner size={12} /> : <RefreshCw size={12} />}
            Check Now
          </Button>
        </FormRow>
      </FormGroup>

      <FormGroup
        title="Updating"
        footer="After installing, quit Glade completely (from the menu bar: Quit Glade Completely) and open it again. Closing the window or ⌘Q keeps the old version running."
      >
        <FormRow
          stacked
          label={behind ? "A newer Glade is on main. To update, run this in the repo folder:" : "To update, run this in the repo folder:"}
          description={status?.check?.checkedAt ? `Last checked ${new Date(status.check.checkedAt).toLocaleString()}.` : undefined}
        >
          <CopyCommand command={UPDATE_COMMAND} />
        </FormRow>
      </FormGroup>
    </>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      // clipboard refused: the command stays selectable
    }
  };
  return (
    <div class="flex w-full items-center gap-2">
      <code data-testid="update-command" class="selectable min-w-0 flex-1 truncate rounded-[5px] bg-control px-2 py-1 font-mono text-[0.92rem] text-fg shadow-[0_0_0_0.5px_var(--pi-separator)]">
        {command}
      </code>
      <Button size="sm" onClick={() => void copy()} aria-label="Copy command">
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
