/**
 * REST client for agent versions and updates (I-198, `@glade/protocol` `agent-versions.ts`).
 * `via`: the environment to ask (default the local one, see `state/env-api.ts`): each Mac checks
 * and updates its own agents; paired devices may too.
 */
import type { AgentVersionsStatus } from "@glade/protocol";
import { request, type RequestFn } from "./api";

export function getAgentVersions(via: RequestFn = request): Promise<AgentVersionsStatus> {
  return via<AgentVersionsStatus>("GET", "/agent-versions");
}

/** Check now (answers when done); without `force` the server reuses a check from the last 10 minutes. */
export function checkAgentVersions(force = false, via: RequestFn = request): Promise<AgentVersionsStatus> {
  return via<AgentVersionsStatus>("POST", `/agent-versions/check${force ? "?force=1" : ""}`);
}

/** Start the agent's updater, or queue it until its working chats finish. */
export function startAgentUpdate(harness: string, via: RequestFn = request): Promise<AgentVersionsStatus> {
  return via<AgentVersionsStatus>("POST", `/agent-versions/${encodeURIComponent(harness)}/update`);
}

/** Cancel an update that's waiting for chats. */
export function cancelAgentUpdate(harness: string, via: RequestFn = request): Promise<AgentVersionsStatus> {
  return via<AgentVersionsStatus>("POST", `/agent-versions/${encodeURIComponent(harness)}/update/cancel`);
}
