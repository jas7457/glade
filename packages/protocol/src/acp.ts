/**
 * ACP agents the user configured (I-119): any Agent Client Protocol agent, started by command.
 * Each one is its own harness (`acpHarnessId`) in the agent picker. Stored in
 * `Settings.harnesses.acp.agents`; none by default, so nothing starts until the user adds one.
 */

export interface AcpAgentConfig {
  /** Stable id (letters, digits, `-`, `_`); the harness id is `acp-<id>`. */
  id: string;
  /** Display name ("Gemini CLI"). */
  name: string;
  /** Executable (a name on PATH or an absolute path). */
  command: string;
  args: string[];
  /** Extra environment variables for the agent process. */
  env: Record<string, string>;
}

/** `Settings.harnesses.acp`. */
export interface AcpHarnessSettings {
  agents: AcpAgentConfig[];
}

/** Harness ids of ACP agents start with this. */
export const ACP_HARNESS_PREFIX = "acp-";

export function acpHarnessId(agentId: string): string {
  return `${ACP_HARNESS_PREFIX}${agentId}`;
}

export function isAcpHarnessId(id: string): boolean {
  return id.startsWith(ACP_HARNESS_PREFIX);
}

/** A valid agent id: 1–40 letters, digits, `-` or `_`. */
export function isValidAcpAgentId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,40}$/.test(id);
}

/** A readable id for a new agent named `name`, unique among `taken` (`"Gemini CLI"` → `gemini-cli`). */
export function acpAgentIdFor(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "agent";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * The usable agents of a stored list: well-formed entries with a unique id, a name and a command.
 * Anything else (hand-edited settings, older data) is skipped rather than failing.
 */
export function normalizeAcpAgents(value: unknown): AcpAgentConfig[] {
  if (!Array.isArray(value)) return [];
  const out: AcpAgentConfig[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const command = typeof r.command === "string" ? r.command.trim() : "";
    if (!isValidAcpAgentId(id) || !name || !command || out.some((a) => a.id === id)) continue;
    const args = Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === "string") : [];
    const env: Record<string, string> = {};
    if (r.env && typeof r.env === "object" && !Array.isArray(r.env)) {
      for (const [key, v] of Object.entries(r.env as Record<string, unknown>)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof v === "string") env[key] = v;
      }
    }
    out.push({ id, name, command, args, env });
  }
  return out;
}
