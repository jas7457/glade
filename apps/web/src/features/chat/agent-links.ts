/**
 * Opening a sub-agent from inside a chat (I-080): the workspace view provides this around the
 * main chat so a sub-agent report card (`AgentMessageCard`) can turn the agent's name into a
 * link that opens it in the right-hand pane. Absent (null) elsewhere, e.g. in a sub-agent's own
 * pane, where names stay plain text.
 */
import { createContext } from "preact";
import { useContext } from "preact/hooks";

export interface AgentLinks {
  /** Open the sub-agent called `name`; `false` when it no longer exists (closed agents are deleted). */
  canOpen(name: string): boolean;
  open(name: string): void;
  /** Open a sub-agent by its session id (spawn cards, I-084). */
  openSession?(sessionId: string): void;
}

export const AgentLinksContext = createContext<AgentLinks | null>(null);

export function useAgentLinks(): AgentLinks | null {
  return useContext(AgentLinksContext);
}
