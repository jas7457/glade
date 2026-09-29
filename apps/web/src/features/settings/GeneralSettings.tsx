import { Button, FormGroup, FormRow, Switch } from "@/ui";
import { settings } from "@/state/store";
import { updateSettings } from "@/state/actions";
import { hasLocalEnvironment } from "@/state/env-registry";
import { isDesktop } from "@/lib/desktop";
import { DesktopAppSettings, KeepAwakeSettings } from "./DesktopAppSettings";
import { notificationPermission, notificationPrefs, requestNotificationPermission, updateNotificationPrefs, type NotificationPrefs } from "@/state/notifications";

export function GeneralSettings() {
  const g = settings.value.general;
  return (
    <>
      <FormGroup title="Chats">
        <FormRow label="Generate chat titles" description="Name new chats with a model after the first message.">
          <Switch
            aria-label="Generate chat titles"
            checked={g.generateTitles}
            onCheckedChange={(generateTitles) => void updateSettings({ general: { generateTitles } })}
          />
        </FormRow>
        <FormRow
          label="Summarize chats"
          description="Write a one-line summary of each chat with the small model after it replies, so “Ask” in the command palette (⌘K, then ⇥) finds chats more reliably."
        >
          <Switch
            aria-label="Summarize chats"
            checked={g.generateSummaries}
            onCheckedChange={(generateSummaries) => void updateSettings({ general: { generateSummaries } })}
          />
        </FormRow>
      </FormGroup>

      <NotificationSettings />
      {hasLocalEnvironment.value && <KeepAwakeSettings />}
      {isDesktop() && <DesktopAppSettings />}
    </>
  );
}

/** Per device (I-135): stored in this app/browser, not on the server. */
function NotificationSettings() {
  const prefs = notificationPrefs.value;
  const permission = notificationPermission.value;
  const toggle = (key: keyof NotificationPrefs, label: string, description?: string) => (
    <FormRow label={label} description={description}>
      <Switch aria-label={label} checked={prefs[key]} onCheckedChange={(on) => updateNotificationPrefs({ [key]: on })} />
    </FormRow>
  );
  const anyOn = prefs.needsInput || prefs.finished || prefs.failed;
  return (
    <FormGroup
      title="Notifications"
      footer={anyOn ? <PermissionHint permission={permission} /> : undefined}
      actions={
        anyOn && permission === "default" ? (
          <Button size="sm" variant="secondary" onClick={() => void requestNotificationPermission()}>
            Allow Notifications…
          </Button>
        ) : undefined
      }
    >
      {toggle("needsInput", "When a chat needs your input", "An agent asks a question or for permission.")}
      {toggle("finished", "When a chat finishes")}
      {toggle("failed", "When a chat fails", "An error, or the run was interrupted.")}
      {toggle("backgroundOnly", "Only while Glade is in the background")}
    </FormGroup>
  );
}

function PermissionHint({ permission }: { permission: string }) {
  if (permission === "denied") {
    return (
      <span class="text-danger">
        {isDesktop()
          ? "Notifications are turned off for Glade in System Settings. Turn them on in System Settings › Notifications › Glade."
          : "Notifications are blocked for this site. Allow them in your browser's site settings."}
      </span>
    );
  }
  if (permission === "unavailable") return <>{isDesktop() ? "Notifications aren't available in this build of Glade." : "This browser can't show notifications here."}</>;
  if (permission === "default") return <>Glade asks for permission before the first notification.</>;
  return <>Notifications are for the top-level chats; sub-agents report to their chat. Settings are for this device.</>;
}
