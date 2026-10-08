/**
 * One-shot completions with pi's print mode (`pi -p --no-session …`): `PiHarness.complete`, used
 * for chat titles, summaries and the chat finder (I-046, I-067). No tools, skills or context
 * files, thinking off, stdin closed; extensions stay on (they may provide the provider/auth the
 * model needs: with them disabled, Anthropic subscription auth was rejected in testing).
 * Never writes a session file.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { modelKey } from "@glade/protocol";
import type { CompletionRequest } from "../types.js";
import { piChildEnv } from "./child-env.js";

const execFileAsync = promisify(execFile);

export interface PiOneShotOptions extends CompletionRequest {
  /** pi executable. */
  piPath: string;
  /** Arguments before Glade's own (a custom command's, I-201). */
  piArgs?: string[];
  /** Working directory for the pi process (e.g. the scratch folder). */
  cwd: string;
  /** Extra environment for the pi process (e.g. `LLAMA_BASE_URL`, I-196). */
  env?: Record<string, string>;
  log?: (msg: string) => void;
}

/** The trimmed reply of `pi -p`, or `null` when it failed or was empty. Never throws. */
export async function piOneShot({ piPath, piArgs = [], cwd, prompt, model, timeoutMs = 45_000, env, log }: PiOneShotOptions): Promise<string | null> {
  const args = [...piArgs, "-p", "--no-session", "--no-tools", "--no-skills", "--no-context-files"];
  if (model) args.push("--model", modelKey(model), "--thinking", "off");
  args.push("--", prompt);
  try {
    const pending = execFileAsync(piPath, args, { cwd, env: piChildEnv(process.env, env), timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    // `pi -p` reads piped stdin as extra input; close it so it doesn't wait for EOF.
    pending.child.stdin?.end();
    const { stdout } = await pending;
    return stdout.trim() || null;
  } catch (err) {
    log?.(`one-shot completion failed: ${(err as Error).message}`);
    return null;
  }
}
