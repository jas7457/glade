/**
 * Environment for the pi processes we start (I-038, I-037).
 *
 * The server may itself run inside a terminal multiplexer such as cmux, whose `CMUX_*` variables
 * would make pi extensions (e.g. agent-teams' `spawn_agent`) drive the user's terminal window
 * instead of pi-ui. `PI_AGENT_TEAMS_*` marks a process as an agent-teams child/parent and must
 * not leak either. The agent-API identity (`PI_UI_URL`, `PI_UI_SESSION_ID`, `PI_UI_TOKEN`,
 * `PI_UI_AGENT_NAME`) is never inherited (a server started from inside a pi-ui session would
 * otherwise hand its own session's identity to every pi); pi-ui passes each session its own via
 * `extra`. Everything else (PATH, HOME, provider keys, …) is passed through unchanged.
 */

/** Variable name prefixes never passed to pi. */
export const STRIPPED_ENV_PREFIXES = ["CMUX_", "PI_AGENT_TEAMS_"] as const;

/** Exact variable names never inherited (the agent API identity, see `AGENT_ENV`). */
export const STRIPPED_ENV_NAMES = ["PI_UI_URL", "PI_UI_SESSION_ID", "PI_UI_TOKEN", "PI_UI_AGENT_NAME"] as const;

/** A copy of `env` without the variables pi must not inherit, plus `extra`. */
export function piChildEnv(env: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if ((STRIPPED_ENV_NAMES as readonly string[]).includes(key)) continue;
    out[key] = value;
  }
  return { ...out, ...extra };
}
