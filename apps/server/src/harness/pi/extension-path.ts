/**
 * Where Glade's own pi extension (`extension/glade-tools.ts`, I-116) is on disk, and the CLI args /
 * environment that load it into a pi process.
 *
 * - `pnpm dev` / tests: next to this module, `src/harness/pi/extension/glade-tools.ts`.
 * - Desktop app: the server is bundled into `app/server.mjs` and `bundle-server.mjs` copies the file
 *   to `app/pi-extension/glade-tools.ts` (pi compiles TypeScript extensions itself, with jiti).
 * - `GLADE_PI_EXTENSION` overrides both (a path; `off` disables loading it).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const EXTENSION_FILE = "glade-tools.ts";

/** Candidate locations, in order, for a module living in `moduleDir`. */
export function extensionCandidates(moduleDir: string): string[] {
  return [join(moduleDir, "extension", EXTENSION_FILE), join(moduleDir, "pi-extension", EXTENSION_FILE)];
}

let cached: string | null | undefined;

/** Path of Glade's pi extension, or null when it can't be found (or is turned off). */
export function gladeExtensionPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.GLADE_PI_EXTENSION;
  if (override === "off") return null;
  if (override) return existsSync(override) ? override : null;
  if (cached !== undefined) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  cached = extensionCandidates(here).find((p) => existsSync(p)) ?? null;
  return cached;
}

/**
 * Args + env that load the extension into a session's pi process. `GLADE_TOOLS=1` tells ext-kit's
 * agent-teams that Glade provides the tools (it then registers nothing); `GLADE_SUBAGENTS=off`
 * is the "Use sub-agents" setting. Without the extension file nothing is added, so an installed
 * ext-kit keeps providing the tools as before.
 */
export function gladeExtensionLaunch(
  extensionPath: string | null,
  subagents: boolean,
): { args: string[]; env: Record<string, string> } {
  if (!extensionPath) return { args: [], env: {} };
  const env: Record<string, string> = { GLADE_TOOLS: "1" };
  if (!subagents) env.GLADE_SUBAGENTS = "off";
  return { args: ["-e", extensionPath], env };
}
