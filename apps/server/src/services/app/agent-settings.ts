/**
 * `Settings.agents` in a settings patch (I-155, I-201): per agent `enabled` and `advanced`
 * (booleans) and `command` (a custom command or `null`). Commands are trimmed (empty = `null`) and
 * checked like the agent page checks them (`agentCommandError`: quotes, no shell syntax, Glade's
 * own flags reserved); anything else is a 400 with the reason.
 */
import { agentCommandError, type DeepPartial, type Settings } from "@glade/protocol";
import { HttpError } from "./errors.js";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The patch with its agent commands trimmed; throws {@link HttpError} 400 when invalid. */
export function sanitizeAgentsPatch(patch: DeepPartial<Settings>): DeepPartial<Settings> {
  const agents = (patch as { agents?: unknown })?.agents;
  if (agents === undefined) return patch;
  if (!isRecord(agents)) throw new HttpError(400, "agents must map agent ids to objects");
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, entry] of Object.entries(agents)) {
    if (entry === undefined) continue;
    if (!isRecord(entry)) throw new HttpError(400, `agents.${id} must be an object`);
    const next: Record<string, unknown> = { ...entry };
    for (const key of ["enabled", "advanced"] as const) {
      if (entry[key] !== undefined && typeof entry[key] !== "boolean") throw new HttpError(400, `agents.${id}.${key} must be true or false`);
    }
    if (entry.command !== undefined) {
      if (entry.command !== null && typeof entry.command !== "string") throw new HttpError(400, `agents.${id}.command must be a string or null`);
      const command = typeof entry.command === "string" ? entry.command.trim() : "";
      const error = agentCommandError(id, command);
      if (error) throw new HttpError(400, error);
      next.command = command || null;
    }
    out[id] = next;
  }
  return { ...patch, agents: out } as DeepPartial<Settings>;
}
