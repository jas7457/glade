/**
 * Native folder picker for the "Create project" dialog. The browser can't learn an absolute path
 * from its own file picker, but this server runs on the user's machine, so it shows the OS dialog
 * itself and returns the chosen path. macOS only (AppleScript `choose folder` via `osascript`);
 * other platforms report {@link FolderPickerUnavailableError} (→ 501) and the UI falls back to a
 * path field. Under Tauri the web app uses the Tauri dialog plugin instead.
 */
import { execFile } from "node:child_process";
import type { PickFolderResponse } from "@glade/protocol";

export interface PickFolderOptions {
  /** Text shown in the dialog. */
  prompt?: string;
  /** Folder the dialog starts in (absolute path; `~` not expanded). */
  defaultPath?: string;
}

export type FolderPicker = (options?: PickFolderOptions) => Promise<PickFolderResponse>;

/** Runs `osascript` with the given args; resolves with stdout, rejects with an error carrying stderr. */
export type OsascriptRunner = (args: string[]) => Promise<string>;

export class FolderPickerUnavailableError extends Error {}

/** The user may take a while to pick; the dialog is abandoned after this long. */
export const PICK_FOLDER_TIMEOUT_MS = 10 * 60_000;

const DEFAULT_PROMPT = "Choose a project folder";

/** Quote a string as an AppleScript string literal. */
export function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The AppleScript that shows the dialog. A bare `osascript` is a background-only process, so its
 * dialog would open behind the browser; turning it into an accessory app and activating it (via
 * AppleScriptObjC) brings the dialog to the front. This targets no other app, so it needs no
 * Automation permission (`tell application "System Events"` would prompt, and fail if denied).
 */
export function buildChooseFolderScript({ prompt, defaultPath }: PickFolderOptions = {}): string {
  const location = defaultPath ? ` default location (POSIX file ${appleScriptString(defaultPath)})` : "";
  return [
    `use framework "AppKit"`,
    `use scripting additions`,
    `set NSApp to current application's NSApplication's sharedApplication()`,
    `NSApp's setActivationPolicy:1`, // NSApplicationActivationPolicyAccessory: no Dock icon
    `NSApp's activateIgnoringOtherApps:true`,
    `set chosen to choose folder with prompt ${appleScriptString(prompt || DEFAULT_PROMPT)}${location}`,
    `return POSIX path of chosen`,
  ].join("\n");
}

/** Default runner: `osascript -e <script>` without a shell. */
export const runOsascript: OsascriptRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile("osascript", args, { timeout: PICK_FOLDER_TIMEOUT_MS, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve(stdout);
    });
  });

/** True for osascript failures that mean "the user pressed Cancel" (error -128). */
function isUserCancel(err: unknown): boolean {
  const text = `${(err as { stderr?: string })?.stderr ?? ""} ${(err as Error)?.message ?? ""}`;
  return /-128\b|User cancel+ed/i.test(text);
}

export interface CreateFolderPickerOptions {
  platform?: NodeJS.Platform;
  run?: OsascriptRunner;
}

export function createFolderPicker({ platform = process.platform, run = runOsascript }: CreateFolderPickerOptions = {}): FolderPicker {
  let open = false;
  return async (options = {}) => {
    if (platform !== "darwin") throw new FolderPickerUnavailableError("The native folder picker is only available on macOS");
    // One dialog at a time; a second click while it's open just reports cancelled.
    if (open) return { cancelled: true };
    open = true;
    try {
      const stdout = await run(["-e", buildChooseFolderScript(options)]);
      const path = stdout.trim().replace(/(.)\/+$/, "$1");
      return path ? { path } : { cancelled: true };
    } catch (err) {
      if (isUserCancel(err)) return { cancelled: true };
      if ((err as { killed?: boolean }).killed) return { cancelled: true }; // timed out
      throw new Error(`Folder picker failed: ${((err as { stderr?: string }).stderr || (err as Error).message).trim()}`);
    } finally {
      open = false;
    }
  };
}
