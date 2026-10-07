/**
 * App-wide notice while Glade waits to restart into a newly installed version (I-197):
 * "Glade restarts when 2 chats finish" with Restart Now / Cancel, then "Restarting Glade…".
 * Shown on every screen (the restart itself is driven by `startAutoRestart`, state/update.ts).
 * The same wait started from Settings (Restart When Chats Finish) shows it too.
 */
import { RotateCw } from "lucide-preact";
import { Button, Spinner } from "@glade/app-core/ui";
import { Notice } from "@glade/app-core/ui/Notice";
import { busyChats, cancelRestartWait, restartNow, restarting, restartWaiting } from "@/state/update";

const chats = (n: number) => `${n} chat${n === 1 ? "" : "s"}`;

export function RestartNotice() {
  if (restarting.value) {
    return <Notice data-testid="restart-notice" icon={<Spinner size={14} />} title="Restarting Glade…" message="It reopens where you are." />;
  }
  if (!restartWaiting.value) return null;
  const busy = busyChats.value;
  return (
    <Notice
      data-testid="restart-notice"
      icon={<RotateCw size={14} class="text-accent" />}
      title="A new version of Glade is installed"
      message={busy > 0 ? `Glade restarts when ${chats(busy)} finish${busy === 1 ? "es" : ""}.` : "Restarting…"}
      actions={
        <>
          <Button size="sm" onClick={() => cancelRestartWait()}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={() => void restartNow()}>
            Restart Now
          </Button>
        </>
      }
    />
  );
}
