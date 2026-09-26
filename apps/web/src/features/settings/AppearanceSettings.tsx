import { Monitor, Moon, Sun } from "lucide-preact";
import { FormGroup, FormRow, SegmentedControl } from "@/ui";
import { settings } from "@/state/store";
import { updateSettings } from "@/state/actions";

export function AppearanceSettings() {
  const a = settings.value.appearance;
  return (
    <FormGroup>
      <FormRow label="Appearance" description={a.theme === "system" ? "Follows your macOS appearance." : undefined}>
        <SegmentedControl
          aria-label="Theme"
          value={a.theme}
          onChange={(theme) => void updateSettings({ appearance: { theme } })}
          options={[
            { value: "system", label: <><Monitor /> Auto</> },
            { value: "light", label: <><Sun /> Light</> },
            { value: "dark", label: <><Moon /> Dark</> },
          ]}
        />
      </FormRow>
      <FormRow label="Text size">
        <SegmentedControl
          aria-label="Text size"
          value={a.fontSize}
          onChange={(fontSize) => void updateSettings({ appearance: { fontSize } })}
          options={[
            { value: "small", label: "Small" },
            { value: "medium", label: "Medium" },
            { value: "large", label: "Large" },
          ]}
        />
      </FormRow>
    </FormGroup>
  );
}
