/**
 * `pnpm tauri:install [--when-idle] [--skip-build]`: build the desktop app, quit a running pi-ui,
 * and replace /Applications/pi-ui.app with the fresh build (ad-hoc signed by the build; local use
 * only), then re-register it with LaunchServices so the Dock / app switchers don't keep a stale
 * icon.
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
const built = join(desktopDir, "src-tauri", "target", "release", "bundle", "macos", "pi-ui.app");
const target = "/Applications/pi-ui.app";
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

/** Only the installed app: `tauri dev`'s "pi-ui (dev).app" runs a process named pi-ui too. */
function installedAppRunning() {
  try {
    execFileSync("pgrep", ["-f", `${target}/Contents/MacOS/pi-ui`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

try {
  execFileSync("osascript", ["-e", 'if application "pi-ui" is running then quit app "pi-ui"'], { stdio: "ignore" });
} catch {
  // not running / not scriptable: fine
}
// Give the app time to exit (it stops its server on the way out, ≤ 5s).
for (let i = 0; i < 40 && installedAppRunning(); i++) execSync("sleep 0.25");
if (installedAppRunning()) {
  // Most likely its "N chats are still working" confirmation is open and was cancelled.
  console.error("[install] pi-ui is still running (chats may still be working). Quit it, or use --when-idle.");
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
