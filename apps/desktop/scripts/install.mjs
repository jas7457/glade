/**
 * `pnpm tauri:install [--when-idle] [--skip-build]`: build the desktop app, quit a running Glade,
 * and replace /Applications/Glade.app with the fresh build (ad-hoc signed by the build; local use
 * only), then re-register it with LaunchServices so the Dock / app switchers don't keep a stale
 * icon.
 *
 * I-059 (renamed from pi-ui): a running pre-rename `/Applications/pi-ui.app` is quit the same way,
 * and removed once Glade.app is installed (its data folder stays; Glade copies it on first start).
 *
 * `--when-idle` (I-058): after building, wait until no chat on the installed app's server is
 * working or waiting for input (progress is printed), then quit and install. Chats running in
 * another server (e.g. `pnpm dev`) aren't affected by the restart and aren't waited for.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitUntilIdle } from "./idle.mjs";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = join(desktopDir, "..", "..");
const built = join(desktopDir, "src-tauri", "target", "release", "bundle", "macos", "Glade.app");
const target = "/Applications/Glade.app";
/** The app before the rename (I-059). */
const legacyTarget = "/Applications/pi-ui.app";
const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

if (!process.argv.includes("--skip-build")) {
  execSync("pnpm tauri:build", { cwd: repoDir, stdio: "inherit" });
}
if (!existsSync(built)) {
  console.error(`[install] build output not found: ${built}`);
  process.exit(1);
}

if (process.argv.includes("--when-idle")) await waitUntilIdle();

/**
 * Only the installed app (by its path): `tauri dev`'s "Glade (dev).app" runs the same binary
 * name from target/debug.
 */
function running(app) {
  try {
    execFileSync("pgrep", ["-f", `${app}/Contents/MacOS/`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const installedAppRunning = () => running(target) || running(legacyTarget);

// Ask by path (not by name, which could make AppleScript ask "Where is …?"), so it's the
// installed copy that quits and gets the chance to confirm (I-024).
for (const app of [target, legacyTarget]) {
  if (!running(app)) continue;
  try {
    execFileSync("osascript", ["-e", `tell application (POSIX file ${JSON.stringify(app)} as text) to quit`], { stdio: "ignore" });
  } catch {
    // not scriptable / already gone: fine
  }
}
// Give the app time to exit (it stops its server on the way out, ≤ 5s).
for (let i = 0; i < 40 && installedAppRunning(); i++) execSync("sleep 0.25");
if (installedAppRunning()) {
  // Most likely its "N chats are still working" confirmation is open and was cancelled.
  const which = running(target) ? "Glade" : "pi-ui";
  console.error(`[install] ${which} is still running (chats may still be working). Quit it, or use --when-idle.`);
  process.exit(1);
}

execFileSync("rm", ["-rf", target], { stdio: "inherit" });
execFileSync("ditto", [built, target], { stdio: "inherit" });
execFileSync("touch", [target]);
try {
  execFileSync(lsregister, ["-f", target], { stdio: "ignore" });
} catch {
  // best effort: LaunchServices also notices the new bundle on first launch
}
console.log(`[install] installed ${target}`);

// I-059: the pre-rename app is replaced by Glade.app; its data folder is left alone (a backup).
if (existsSync(legacyTarget) && existsSync(join(target, "Contents", "Info.plist"))) {
  try {
    execFileSync(lsregister, ["-u", legacyTarget], { stdio: "ignore" });
  } catch {
    // best effort
  }
  execFileSync("rm", ["-rf", legacyTarget], { stdio: "inherit" });
  console.log(`[install] removed the old ${legacyTarget} (its data folder stays; Glade copies it on first start)`);
}
