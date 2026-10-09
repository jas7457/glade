/**
 * `Settings.agentDefs` (I-218): turning agents on/off globally and per project.
 *
 * A settings patch is checked and normalised here (names as {@link normalizeAgentDefName}, unknown
 * projects dropped). Settings patches merge deeply, so `null` removes: `projects: { <id>: null }`
 * clears a project's overrides, `projects: { <id>: { scout: null } }` one override (the store
 * prunes the nulls after merging, `pruneAgentDefSwitches`). A deleted project's overrides go with
 * it ({@link dropProjectAgentDefs}). {@link agentDefsListContext} is what list/resolve need.
 */
import { normalizeAgentDefName, type DeepPartial, type Settings } from "@glade/protocol";
import type { AppContext } from "../app/context.js";
import { HttpError } from "../app/errors.js";
import type { AgentDefsListContext } from "./service.js";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The patch with `agentDefs` checked and normalised (400 when malformed); other keys untouched. */
export function sanitizeAgentDefsPatch(patch: DeepPartial<Settings>, knownProjectIds: ReadonlySet<string>): DeepPartial<Settings> {
  const value = (patch as { agentDefs?: unknown })?.agentDefs;
  if (value === undefined) return patch;
  if (!isRecord(value)) throw new HttpError(400, "agentDefs must be an object");
  const out: Record<string, unknown> = {};
  if (value.disabled !== undefined) {
    if (!Array.isArray(value.disabled) || value.disabled.some((n) => typeof n !== "string")) throw new HttpError(400, "agentDefs.disabled must be a list of agent names");
    out.disabled = [...new Set((value.disabled as string[]).map(normalizeAgentDefName).filter(Boolean))];
  }
  if (value.projects !== undefined) {
    if (!isRecord(value.projects)) throw new HttpError(400, "agentDefs.projects must map project ids to { name: true | false }");
    const projects: Record<string, unknown> = {};
    for (const [projectId, names] of Object.entries(value.projects)) {
      if (names === undefined) continue;
      if (names === null) {
        projects[projectId] = null; // clears the project's overrides
        continue;
      }
      if (!isRecord(names)) throw new HttpError(400, `agentDefs.projects.${projectId} must map agent names to true, false or null`);
      if (!knownProjectIds.has(projectId)) continue;
      const entry: Record<string, boolean | null> = {};
      for (const [name, on] of Object.entries(names)) {
        if (on === undefined) continue;
        if (on !== null && typeof on !== "boolean") throw new HttpError(400, `agentDefs.projects.${projectId}.${name} must be true, false or null`);
        const key = normalizeAgentDefName(name);
        if (key) entry[key] = on;
      }
      projects[projectId] = entry;
    }
    out.projects = projects;
  }
  return { ...patch, agentDefs: out } as DeepPartial<Settings>;
}

/** Remove a deleted project's switches and push the new settings (no-op when it had none). */
export function dropProjectAgentDefs(ctx: AppContext, projectId: string): void {
  const projects = ctx.store.getSettings().agentDefs?.projects ?? {};
  if (!(projectId in projects)) return;
  const patch = { agentDefs: { projects: { [projectId]: null } } } as unknown as DeepPartial<Settings>;
  const settings = ctx.store.updateSettings(patch);
  ctx.broadcast({ type: "settings", settings });
}

/** The switches and offered harnesses of this server, for `AgentDefsService.list`/`resolve`. */
export function agentDefsListContext(ctx: Pick<AppContext, "store" | "harnesses">): AgentDefsListContext {
  return {
    switches: ctx.store.getSettings().agentDefs ?? { disabled: [], projects: {} },
    offeredHarnesses: ctx.harnesses.offered().map((h) => h.id),
  };
}
