/**
 * Installed harnesses and what they can do (I-065). Loaded from `GET /api/harnesses`; until then
 * (or if the request fails) every capability is assumed, so nothing flickers away for pi users.
 *
 *   const caps = harnessCapabilities(session.harness); if (caps.compact) …
 *   harnessLabel(session.harness) // "pi"
 */
import { computed, signal } from "@preact/signals";
import type { HarnessCapabilities, HarnessInfo } from "@glade/protocol";
import { request } from "@/lib/api";

export const harnesses = signal<HarnessInfo[] | null>(null);

const ALL: HarnessCapabilities = {
  compact: true,
  exportHtml: true,
  steering: true,
  uiRequests: true,
  usageLimits: true,
  commands: true,
  subagents: true,
  shell: true,
};

/** The harness new chats use (first `isDefault`, else the first one). */
export const defaultHarness = computed(() => harnesses.value?.find((h) => h.isDefault) ?? harnesses.value?.[0] ?? null);

function find(id: string | null | undefined): HarnessInfo | null {
  const list = harnesses.value;
  if (!list) return null;
  return (id ? list.find((h) => h.id === id) : null) ?? defaultHarness.value;
}

/** Capabilities of a harness (`null` id = the default harness). All true until loaded. */
export function harnessCapabilities(id?: string | null): HarnessCapabilities {
  return find(id)?.capabilities ?? ALL;
}

/** Display name for copy ("Ask pi to work on…"). Falls back to "the agent". */
export function harnessLabel(id?: string | null): string {
  return find(id)?.label ?? "the agent";
}

export async function loadHarnesses(): Promise<void> {
  try {
    harnesses.value = await request<HarnessInfo[]>("GET", "/harnesses");
  } catch {
    /* older server or not ready: keep the permissive defaults */
  }
}
