/**
 * REST client for Glade agents (I-218, `@glade/protocol` `agent-defs.ts`): list, save, delete,
 * draft a description, and a harness's live tool list. `via`: the environment to ask (default the
 * local one, see `state/env-api.ts`): agents live on the device that runs them.
 */
import type {
  AgentDef,
  AgentDefScope,
  AgentDefToolsResponse,
  DescribeAgentDefRequest,
  DescribeAgentDefResponse,
  ListAgentDefsResponse,
  SaveAgentDefRequest,
  SaveAgentDefResponse,
} from "@glade/protocol";
import { request, type RequestFn } from "./api";

function query(params: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Every agent visible in `projectId` (`null` = a standalone chat), with switches and availability. */
export async function listAgentDefs(projectId: string | null, via: RequestFn = request): Promise<AgentDef[]> {
  return (await via<ListAgentDefsResponse>("GET", `/agent-defs${query({ projectId })}`)).agents;
}

/** Create or replace a Glade agent (`previousName` renames). */
export async function saveAgentDef(req: SaveAgentDefRequest, via: RequestFn = request): Promise<AgentDef> {
  return (await via<SaveAgentDefResponse>("PUT", "/agent-defs", req)).agent;
}

export function deleteAgentDef(scope: AgentDefScope, name: string, projectId: string | null, via: RequestFn = request): Promise<void> {
  return via<void>("DELETE", `/agent-defs${query({ scope, name, projectId })}`);
}

/** A description drafted from the prompt by the quick-tasks model. */
export async function describeAgentDef(req: DescribeAgentDefRequest, via: RequestFn = request): Promise<string> {
  return (await via<DescribeAgentDefResponse>("POST", "/agent-defs/describe", req)).description;
}

/** `harness`'s tools as last seen in a session of `projectId` (`seenAt` null = never seen). */
export function getAgentDefTools(harness: string, projectId: string | null, via: RequestFn = request): Promise<AgentDefToolsResponse> {
  return via<AgentDefToolsResponse>("GET", `/agent-defs/tools${query({ harness, projectId })}`);
}
