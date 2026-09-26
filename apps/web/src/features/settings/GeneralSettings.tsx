import { useState } from "preact/hooks";
import { FormGroup, FormRow, SegmentedControl, Switch } from "@/ui";
import { settings } from "@/state/store";
import { updateSettings } from "@/state/actions";
import { ensureNotificationPermission } from "@/state/attention";

export function GeneralSettings() {
  const g = settings.value.general;
  const [permission, setPermission] = useState<string | null>(null);
  return (
    <>
      <FormGroup title="Composer">
        <FormRow label="Send message with" description={g.sendKey === "enter" ? "⇧↩ inserts a new line." : "↩ inserts a new line."}>
          <SegmentedControl
            aria-label="Send key"
            value={g.sendKey}
            onChange={(sendKey) => void updateSettings({ general: { sendKey } })}
            options={[
              { value: "enter", label: "↩ Return" },
              { value: "mod-enter", label: "⌘↩ Command-Return" },
            ]}
          />
        </FormRow>
        <FormRow
          label="While the agent is working"
          description={
            g.busyBehavior === "steer"
              ? "Steer: your message is delivered as soon as the current tool call finishes, redirecting the agent mid-run."
              : "Follow-up: your message waits until the agent has completely finished, then starts a new turn."
          }
        >
          <SegmentedControl
            aria-label="Busy behavior"
            value={g.busyBehavior}
            onChange={(busyBehavior) => void updateSettings({ general: { busyBehavior } })}
            options={[
              { value: "steer", label: "Steer" },
              { value: "followUp", label: "Follow-up" },
            ]}
          />
        </FormRow>
      </FormGroup>

      <FormGroup title="Chats">
        <FormRow label="Generate chat titles" description="Name new chats with a model after the first message.">
          <Switch
            aria-label="Generate chat titles"
            checked={g.generateTitles}
            onCheckedChange={(generateTitles) => void updateSettings({ general: { generateTitles } })}
          />
        </FormRow>
        <FormRow
          label="Notify when a chat finishes"
          description={
            permission === "denied"
              ? "Notifications are blocked. Allow them for pi-ui in System Settings › Notifications."
              : "Show a notification when a chat finishes or needs input while pi-ui is in the background."
          }
        >
          <Switch
            aria-label="Notify when a chat finishes"
            checked={g.notifyOnComplete}
            onCheckedChange={(notifyOnComplete) => {
              void updateSettings({ general: { notifyOnComplete } });
              if (notifyOnComplete) void ensureNotificationPermission().then(setPermission);
            }}
          />
        </FormRow>
      </FormGroup>
    </>
  );
}
