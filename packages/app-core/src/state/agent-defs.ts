/**
 * Settings → Sub-agents (I-218): the edited environment's agent definitions per project (`GET
 * /api/agent-defs?projectId=`), loaded when the page opens and reloaded after a save or delete,
 * and the on/off switches (`Settings.agentDefs`, written through the host settings patch).
 *
 *   loadAgentDefs(projectId); agentDefsOf(projectId) // AgentDef[] | null (null = loading)
 *   setAgentDefOn("scout", projectId, false); clearAgentDefOverride("scout", projectId)
 */
import { signal } from "@preact/signals";
import { agentDefEnabled, type AgentDef, type AgentDefScope, type DeepPartial, type SaveAgentDefRequest, type Settings } from "@glade/protocol";
import { deleteAgentDef as apiDelete, listAgentDefs, saveAgentDef as apiSave } from "@glade/app-core/lib/api-agent-defs";
import { request } from "@glade/app-core/lib/api";
import { requestFor } from "./env-api";
import { hostEnvId, hostSettings, updateHostSettings } from "./host-settings";

export interface AgentDefsLoad {
  agents: AgentDef[] | null;
  error: string | null;
}

/** By `<envId>|<projectId>` (`""` for the local environment / all chats). */
export const agentDefLists = signal<Record<string, AgentDefsLoad>>({});

const keyOf = (projectId: string | null, envId = hostEnvId()) => `${envId ?? ""}|${projectId ?? ""}`;
const via = () => requestFor(hostEnvId()) ?? request;

/** The list for `projectId` on the edited environment (`agents: null` until loaded). */
export function agentDefsOf(projectId: string | null): AgentDefsLoad {
  return agentDefLists.value[keyOf(projectId)] ?? { agents: null, error: null };
}

export async function loadAgentDefs(projectId: string | null): Promise<void> {
  const key = keyOf(projectId);
  try {
    const agents = await listAgentDefs(projectId, via());
    agentDefLists.value = { ...agentDefLists.value, [key]: { agents, error: null } };
  } catch (err) {
    const prev = agentDefLists.value[key]?.agents ?? null;
    agentDefLists.value = { ...agentDefLists.value, [key]: { agents: prev, error: (err as Error).message || "Could not load agents" } };
  }
}

/** Save (create/replace/rename) a Glade agent; reloads the list. Throws the server's error. */
export async function saveAgentDef(req: SaveAgentDefRequest, listProjectId: string | null): Promise<AgentDef> {
  const agent = await apiSave(req, via());
  await loadAgentDefs(listProjectId);
  return agent;
}

/** Delete a Glade agent; reloads the list. Throws the server's error. */
export async function deleteAgentDef(scope: AgentDefScope, name: string, projectId: string | null, listProjectId: string | null): Promise<void> {
  await apiDelete(scope, name, projectId, via());
  await loadAgentDefs(listProjectId);
}

/** The project's own on/off for agent `name`, or null when it follows the global switch. */
export function agentDefOverride(name: string, projectId: string | null): boolean | null {
  const own = projectId ? hostSettings.value.agentDefs?.projects?.[projectId]?.[name] : undefined;
  // A cleared override is `null` until the server's pruned settings arrive.
  return typeof own === "boolean" ? own : null;
}

/** Whether agent `name` is on for `projectId` (`null`: the global switch), from the edited environment's settings. */
export function agentDefOn(name: string, projectId: string | null): boolean {
  return agentDefOverride(name, projectId) ?? agentDefEnabled(hostSettings.value.agentDefs, name, null);
}

/** Drop a project's override of agent `name`: it follows the global switch again. */
export function clearAgentDefOverride(name: string, projectId: string): Promise<boolean> {
  // `null` removes a key in a settings patch (the server prunes it); DeepPartial has no null.
  const patch = { agentDefs: { projects: { [projectId]: { [name]: null } } } } as unknown as DeepPartial<Settings>;
  return updateHostSettings(patch);
}

/**
 * Turn agent `name` on or off: everywhere (`projectId` null: `agentDefs.disabled`), or for one
 * project (an override of the global switch).
 */
export function setAgentDefOn(name: string, projectId: string | null, on: boolean): Promise<boolean> {
  if (projectId) return updateHostSettings({ agentDefs: { projects: { [projectId]: { [name]: on } } } });
  const disabled = (hostSettings.value.agentDefs?.disabled ?? []).filter((n) => n !== name);
  return updateHostSettings({ agentDefs: { disabled: on ? disabled : [...disabled, name] } });
}
