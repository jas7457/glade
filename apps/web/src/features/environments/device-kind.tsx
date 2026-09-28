/** Icon and label of a paired device's kind (I-126). */
import { Globe, Laptop, Monitor, Smartphone } from "lucide-preact";
import type { DeviceKind } from "@glade/protocol";

const LABEL: Record<DeviceKind, string> = { mac: "Mac", phone: "Phone", browser: "Browser", other: "Other device" };

export function deviceKindLabel(kind: DeviceKind): string {
  return LABEL[kind] ?? LABEL.other;
}

export function DeviceKindIcon({ kind, size = 14 }: { kind: DeviceKind; size?: number }) {
  const Icon = kind === "mac" ? Laptop : kind === "phone" ? Smartphone : kind === "browser" ? Globe : Monitor;
  return <Icon size={size} strokeWidth={1.75} aria-label={deviceKindLabel(kind)} class="shrink-0 text-fg-muted" />;
}
