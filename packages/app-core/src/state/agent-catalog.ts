/**
 * Settings → Agents (I-155): every agent the edited environment knows about, installed or not
 * (`GET /api/agent-catalog`). Loaded per environment when the page opens and again when that
 * environment's agent settings change; `null` until loaded (or on an older server).
 */
import { signal } from "@preact/signals";
import type { AgentCatalogEntry } from "@glade/protocol";
import { request } from "@glade/app-core/lib/api";
import { requestFor } from "./env-api";

/** Catalog by environment key (`""` = the local one). */
export const agentCatalogs = signal<Record<string, AgentCatalogEntry[] | null>>({});

export function agentCatalogOf(envId?: string | null): AgentCatalogEntry[] | null {
  return agentCatalogs.value[envId ?? ""] ?? null;
}

export async function loadAgentCatalog(envId?: string | null): Promise<void> {
  try {
    const list = await (requestFor(envId) ?? request)<AgentCatalogEntry[]>("GET", "/agent-catalog");
    agentCatalogs.value = { ...agentCatalogs.value, [envId ?? ""]: list };
  } catch {
    /* older server: the page falls back to the harness list */
  }
}
