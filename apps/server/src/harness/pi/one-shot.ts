/**
 * One-shot completions with pi's print mode (`pi -p --no-session …`), used for chat summaries
 * and the chat finder (I-046). Same approach as `PiHarness.generateTitle`: no tools, skills or
 * context files, thinking off, stdin closed; extensions stay on (they may provide provider auth).
 * Never writes a session file.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { modelKey } from "@pi-ui/protocol";
import type { FastModel } from "../../services/search/types.js";
import { piChildEnv } from "./child-env.js";

const execFileAsync = promisify(execFile);

export interface PiOneShotOptions {
  /** pi executable (resolved per call, so settings changes apply). */
  piPath: () => string;
  /** Working directory for the pi process (e.g. the scratch folder). */
  cwd: string;
  log?: (msg: string) => void;
}

/** A {@link FastModel} backed by `pi -p`. */
export function piFastModel({ piPath, cwd, log }: PiOneShotOptions): FastModel {
  return async ({ prompt, model, timeoutMs = 45_000 }) => {
    const args = ["-p", "--no-session", "--no-tools", "--no-skills", "--no-context-files"];
    if (model) args.push("--model", modelKey(model), "--thinking", "off");
    args.push("--", prompt);
    try {
      const pending = execFileAsync(piPath(), args, { cwd, env: piChildEnv(), timeout: timeoutMs, maxBuffer: 1024 * 1024 });
      // `pi -p` reads piped stdin as extra input; close it so it doesn't wait for EOF.
      pending.child.stdin?.end();
      const { stdout } = await pending;
      return stdout.trim() || null;
    } catch (err) {
      log?.(`one-shot completion failed: ${(err as Error).message}`);
      return null;
    }
  };
}
