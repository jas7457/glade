/**
 * Environment for the pi processes we start (I-038, I-037).
 *
 * The server may itself run inside a terminal multiplexer such as cmux, whose `CMUX_*` variables
 * would make pi extensions (e.g. agent-teams' `spawn_agent`) drive the user's terminal window
 * instead of Glade. `PI_AGENT_TEAMS_*` marks a process as an agent-teams child/parent and must
 * not leak either. The agent-API identity (`GLADE_URL`, `GLADE_SESSION_ID`, `GLADE_TOKEN`,
 * `GLADE_AGENT_NAME`) is never inherited (a server started from inside a Glade session would
 * otherwise hand its own session's identity to every pi); Glade passes each session its own via
 * `extra`. Neither is the server's own listening config (`GLADE_PORT`, `GLADE_HOST`,
 * `GLADE_STATIC_DIR`, `GLADE_EXIT_ON_STDIN_CLOSE`, `GLADE_SERVER_KIND`; I-058): an agent that
 * starts a Glade server from a chat in the installed app must not get the app's port or claim to
 * be the desktop server. Each is stripped under its pre-rename `PI_UI_*` name too (I-059), since
 * the server still reads those as fallbacks. `GLADE_DATA_DIR` / `PI_UI_DATA_DIR` are kept on
 * purpose, so a server started from a sandbox chat stays in the sandbox. Everything else (PATH,
 * HOME, provider keys, …) is passed through.
 */

/** Variable name prefixes never passed to pi. */
export const STRIPPED_ENV_PREFIXES = ["CMUX_", "PI_AGENT_TEAMS_"] as const;

/** Short names (after `GLADE_` / `PI_UI_`) never inherited: agent identity + server config. */
const STRIPPED_SHORT_NAMES = [
  "URL",
  "SESSION_ID",
  "TOKEN",
  "AGENT_NAME",
  "PORT",
  "HOST",
  "STATIC_DIR",
  "EXIT_ON_STDIN_CLOSE",
  "SERVER_KIND",
] as const;

/** Exact variable names never inherited (the agent API identity, see `AGENT_ENV`), under both prefixes. */
export const STRIPPED_ENV_NAMES: readonly string[] = ["GLADE_", "PI_UI_"].flatMap((prefix) =>
  STRIPPED_SHORT_NAMES.map((name) => prefix + name),
);

/** A copy of `env` without the variables pi must not inherit, plus `extra`. */
export function piChildEnv(env: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (STRIPPED_ENV_NAMES.includes(key)) continue;
    out[key] = value;
  }
  return { ...out, ...extra };
}
