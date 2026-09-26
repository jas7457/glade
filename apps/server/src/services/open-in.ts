/**
 * "Open in <app>" for project folders (`POST /api/projects/:id/open`). A small registry of
 * targets; each runs a command without a shell. macOS only for now (`open -a <App> <path>`).
 * The command runner is injectable so tests never launch real apps.
 */
import { execFile } from "node:child_process";
import type { OpenTarget } from "@pi-ui/protocol";

/** Why opening failed; `status` is the HTTP status the route responds with. */
export class OpenInError extends Error {
  constructor(
    readonly status: 424 | 500 | 501,
    message: string,
  ) {
    super(message);
  }
}

export interface OpenTargetSpec {
  /** Human-readable app name, used in error messages. */
  label: string;
  /** Command + args that open `path` in the app (run with execFile, no shell). */
  command: (path: string) => [file: string, args: string[]];
}

export const OPEN_TARGETS: Record<OpenTarget, OpenTargetSpec> = {
  vscode: { label: "Visual Studio Code", command: (path) => ["open", ["-a", "Visual Studio Code", path]] },
};

export function isOpenTarget(value: unknown): value is OpenTarget {
  return typeof value === "string" && Object.hasOwn(OPEN_TARGETS, value);
}

/** Result of running a command: non-zero `exitCode` means failure. */
export interface RunResult {
  exitCode: number;
  stderr: string;
}

export type CommandRunner = (file: string, args: string[]) => Promise<RunResult>;

/** Opens `path` in `target`. Throws {@link OpenInError} (424 not installed, 501 unsupported, 500 other). */
export type OpenIn = (target: OpenTarget, path: string) => Promise<void>;

export const runCommand: CommandRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000 }, (err, _stdout, stderr) => {
      if (!err) return resolve({ exitCode: 0, stderr: String(stderr) });
      const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
      // Spawn failures (e.g. ENOENT) have a string code; exits have a numeric one.
      if (typeof code === "number") return resolve({ exitCode: code, stderr: String(stderr) });
      reject(err);
    });
  });

export function createOpenIn(options: { platform?: NodeJS.Platform; run?: CommandRunner } = {}): OpenIn {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand;
  return async (target, path) => {
    const spec = OPEN_TARGETS[target];
    if (platform !== "darwin") throw new OpenInError(501, `Opening in ${spec.label} is only available on macOS`);
    const [file, args] = spec.command(path);
    const { exitCode, stderr } = await run(file, args);
    if (exitCode === 0) return;
    if (/Unable to find application/i.test(stderr)) {
      throw new OpenInError(424, `${spec.label} isn't installed`);
    }
    throw new OpenInError(500, `Couldn't open ${spec.label}: ${stderr.trim() || `exit code ${exitCode}`}`);
  };
}
