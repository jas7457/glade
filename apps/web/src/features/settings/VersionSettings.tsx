/**
 * The top of Settings → General (I-160, formerly the About page, I-149): the "Glade" group with
 * the commit this Glade was built from, whether origin's main has moved on ("Up to date" /
 * "N commits behind main" / "Update available" / "Couldn't check", with Check Now), and updating:
 * Update Now + restart in the Mac app (I-154, `UpdateNow.tsx`), else the command to run. Then the
 * theme switcher (I-161, formerly the Appearance page).
 */
import { useEffect, useState } from "preact/hooks";
import { Check, Copy, Monitor, Moon, RefreshCw, Sun } from "lucide-preact";
import { UPDATE_COMMAND } from "@glade/protocol";
import { Button, FormGroup, FormRow, SegmentedControl, Spinner, StatusDot } from "@glade/app-core/ui";
import { settings } from "@glade/app-core/state/store";
import { updateSettings } from "@glade/app-core/state/actions";
import { buildLine, checkText, checkVersionNow, loadVersion, versionChecking, versionError, versionStatus } from "@glade/app-core/state/version";
import { canUpdateHere, updateJob, watchUpdateJob } from "@/state/update";
import { UpdateNow } from "./UpdateNow";

/** The "Glade" group: build, update check, and Update Now (or the command where it isn't available). */
export function VersionSettings() {
  useEffect(() => void loadVersion(), []);
  useEffect(() => watchUpdateJob(), []);
  const job = updateJob.value;
  const status = versionStatus.value;
  const build = status?.build ?? null;
  const checking = versionChecking.value || !!status?.checking;
  const line = checkText(status);
  const error = versionError.value;
  const behind = status?.check?.state === "behind" || status?.check?.state === "update-available";
  const updateHere = !!job && canUpdateHere(job);

  return (
    <FormGroup
      title="Glade"
      footer={
        updateHere
          ? undefined
          : "After installing, quit Glade completely (from the menu bar: Quit Glade Completely) and open it again. Closing the window or ⌘Q keeps the old version running."
      }
    >
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
      {updateHere ? (
        <UpdateNow job={job} behind={behind} />
      ) : (
        <FormRow
          stacked
          label={behind ? "A newer Glade is on main. To update, run this in the repo folder:" : "To update, run this in the repo folder:"}
          description={status?.check?.checkedAt ? `Last checked ${new Date(status.check.checkedAt).toLocaleString()}.` : undefined}
        >
          <CopyCommand command={UPDATE_COMMAND} />
        </FormRow>
      )}
    </FormGroup>
  );
}

/** Light / Dark / Auto (I-161: moved here from the removed Appearance page; no Text size). */
export function ThemeSettings() {
  const theme = settings.value.appearance.theme;
  return (
    <FormGroup>
      <FormRow label="Theme" description={theme === "system" ? "Follows your macOS appearance." : undefined}>
        <SegmentedControl
          aria-label="Theme"
          value={theme}
          onChange={(theme) => void updateSettings({ appearance: { theme } })}
          options={[
            { value: "system", label: <><Monitor /> Auto</> },
            { value: "light", label: <><Sun /> Light</> },
            { value: "dark", label: <><Moon /> Dark</> },
          ]}
        />
      </FormRow>
    </FormGroup>
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
