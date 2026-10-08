/**
 * The command each built-in agent runs on this device (I-201): Glade's own (`pi`, `claude`,
 * `codex`) unless the agent's Advanced switch is on and a custom command is saved
 * (`Settings.agents.<id>.advanced` + `command`; parsing and rules in `@glade/protocol`
 * `agent-command.ts`). Everything that starts or detects an agent asks here, at each start, so a
 * change applies to processes started afterwards.
 *
 *   const custom = customCommandFn(() => store.getSettings(), "pi");
 *   new PiHarness({ customCommand: custom, … });       // spawns `mywrapper pi … --mode rpc …`
 *   const watch = agentCommandWatcher(getSettings, ids);
 *   watch()                                            // ids whose command changed since last call
 */
import { customAgentCommand, effectiveAgentCommand, formatCommandLine, type AgentCommandLine, type Settings } from "@glade/protocol";

/** The custom command in effect for one agent, read at each use; null = Glade's own. */
export type CustomCommandFn = () => AgentCommandLine | null;

export function customCommandFn(settings: () => Settings, harnessId: string): CustomCommandFn {
  return () => customAgentCommand(settings(), harnessId);
}

/** `program` + leading args of `harnessId`'s command now (the built-in one when no custom one is in effect). */
export function resolveAgentCommand(custom: CustomCommandFn | undefined, builtin: string): AgentCommandLine {
  return custom?.() ?? { program: builtin, args: [] };
}

/** The effective command line of every agent in `ids`, for display and change detection. */
export function agentCommandLines(settings: Settings, ids: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const c = effectiveAgentCommand(settings, id);
    out[id] = formatCommandLine([c.program, ...c.args]);
  }
  return out;
}

/**
 * Returns a function that answers which agents' effective command changed since it was last
 * called (the first call compares against the settings at creation).
 */
export function agentCommandWatcher(settings: () => Settings, ids: readonly string[]): () => string[] {
  let last = agentCommandLines(settings(), ids);
  return () => {
    const now = agentCommandLines(settings(), ids);
    const changed = ids.filter((id) => now[id] !== last[id]);
    last = now;
    return changed;
  };
}
