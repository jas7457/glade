/**
 * Which agent to name on a chat (I-176): the desktop chat header's agent badge and the iPhone's
 * title line use this, so both follow one rule.
 *
 *   const agent = chatAgentOf(sessionId); // { label: "Claude Code", title: "Runs on Claude Code", … } | null
 *
 * Shown for every chat (the default agent too) when the chat's environment offers two or more
 * agents (installed and enabled, `GET /api/harnesses`); with one, only when the chat runs on
 * another agent than that one (e.g. one that's since been turned off or uninstalled). Nothing
 * until the harness list has loaded.
 *
 * Its own module (not `harnesses.ts`) because it reads the session store, which imports that one.
 */
import { isAcpHarnessId } from "@glade/protocol";
import { defaultHarnessOf, harnessesOf } from "./harnesses";
import { envIdOfSession, sessionsById } from "./store";

export interface ChatAgent {
  /** Harness id (`Session.harness`). */
  id: string;
  /** Display name ("Claude Code"; the id when the agent isn't offered here). */
  label: string;
  /** Tooltip: "Runs on <label>[ (ACP)][, which isn't installed]". */
  title: string;
  /** Is the agent offered by the chat's environment? */
  installed: boolean;
}

export function chatAgentOf(sessionId: string): ChatAgent | null {
  const id = sessionsById.value.get(sessionId)?.harness;
  // The chat's environment's agents (I-123).
  const envId = envIdOfSession(sessionId);
  const list = harnessesOf(envId);
  if (!id || !list) return null;
  if (list.length < 2 && id === defaultHarnessOf(envId)?.id) return null;
  const info = list.find((h) => h.id === id);
  const label = info?.label ?? id;
  const title = `Runs on ${label}${isAcpHarnessId(id) ? " (ACP)" : ""}${info ? "" : ", which isn't installed"}`;
  return { id, label, title, installed: !!info };
}
