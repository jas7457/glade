/**
 * Installed harnesses and what they can do (I-065). Loaded from `GET /api/harnesses`; until then
 * (or if the request fails) every capability is assumed, so nothing flickers away for pi users.
 *
 *   const caps = harnessCapabilities(session.harness); if (caps.compact) …
 *   harnessLabel(session.harness) // "pi"
 *
 * I-123: every environment has its own harnesses (`EnvShell.harnesses`); `harnesses` is the local
 * one's. Functions take an optional environment id (default: the local/primary environment).
 */
import { computed, signal, type Signal } from "@preact/signals";
import type { HarnessCapabilities, HarnessInfo } from "@glade/protocol";
import { request } from "@/lib/api";
import { connectionFor } from "./env-registry";

export const harnesses = signal<HarnessInfo[] | null>(null);

/** The harness list signal of an environment (the local one for untagged/unknown). */
function listSignal(envId?: string | null): Signal<HarnessInfo[] | null> {
  return connectionFor(envId)?.shell.harnesses ?? harnesses;
}

/** Installed harnesses of an environment (`null` until loaded). */
export function harnessesOf(envId?: string | null): HarnessInfo[] | null {
  return listSignal(envId).value;
}

/** The harness new chats on an environment use by default. */
export function defaultHarnessOf(envId?: string | null): HarnessInfo | null {
  const list = harnessesOf(envId);
  return list?.find((h) => h.isDefault) ?? list?.[0] ?? null;
}

const ALL: HarnessCapabilities = {
  compact: true,
  exportHtml: true,
  steering: true,
  uiRequests: true,
  usageLimits: true,
  commands: true,
  subagents: true,
  shell: true,
  sideQuestions: true,
  models: true,
};

/** The harness new chats use (first `isDefault`, else the first one). */
export const defaultHarness = computed(() => harnesses.value?.find((h) => h.isDefault) ?? harnesses.value?.[0] ?? null);

function find(id: string | null | undefined, envId?: string | null): HarnessInfo | null {
  const list = harnessesOf(envId);
  if (!list) return null;
  return (id ? list.find((h) => h.id === id) : null) ?? defaultHarnessOf(envId);
}

/**
 * The agent picked in the new-chat context bar (I-119); `null` = the default harness. Kept while
 * the app runs; a pick that's no longer installed falls back to the default.
 */
export const newChatHarness = signal<string | null>(null);

/**
 * The harness a new chat on an environment will use (`newChatHarness` if that environment has
 * it, else its default).
 */
export function newChatHarnessFor(envId?: string | null): HarnessInfo | null {
  const picked = newChatHarness.value;
  return (picked ? harnessesOf(envId)?.find((h) => h.id === picked) : undefined) ?? defaultHarnessOf(envId);
}

/** The harness a new chat on the local environment will use. */
export const newChatHarnessInfo = computed(() => newChatHarnessFor());

/** Capabilities of a harness (`null` id = the default harness). All true until loaded. */
export function harnessCapabilities(id?: string | null, envId?: string | null): HarnessCapabilities {
  return find(id, envId)?.capabilities ?? ALL;
}

/** Display name for copy ("Ask pi to work on…"). Falls back to "the agent". */
export function harnessLabel(id?: string | null, envId?: string | null): string {
  return find(id, envId)?.label ?? "the agent";
}

export async function loadHarnesses(envId?: string | null): Promise<void> {
  const conn = envId ? connectionFor(envId) : undefined;
  try {
    listSignal(envId).value = await (conn?.request ?? request)<HarnessInfo[]>("GET", "/harnesses");
  } catch {
    /* older server or not ready: keep the permissive defaults */
  }
}
