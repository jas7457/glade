/**
 * Environment for the pi processes we start (I-038).
 *
 * The server may itself run inside a terminal multiplexer such as cmux, whose `CMUX_*` variables
 * would make pi extensions (e.g. agent-teams' `spawn_agent`) drive the user's terminal window
 * instead of pi-ui. `PI_AGENT_TEAMS_*` marks a process as an agent-teams child/parent and must
 * not leak either. Everything else (PATH, HOME, provider keys, …) is passed through unchanged.
 */

/** Variable name prefixes never passed to pi. */
export const STRIPPED_ENV_PREFIXES = ["CMUX_", "PI_AGENT_TEAMS_"] as const;

/** A copy of `env` without the variables pi must not inherit. */
export function piChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    out[key] = value;
  }
  return out;
}
