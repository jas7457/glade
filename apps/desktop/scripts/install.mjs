/**
 * `pnpm tauri:install`: build the desktop app, quit a running pi-ui, and replace
 * /Applications/pi-ui.app with the fresh build (ad-hoc signed by the build; local use only).
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = join(desktopDir, "..", "..");
const built = join(desktopDir, "src-tauri", "target", "release", "bundle", "macos", "pi-ui.app");
const target = "/Applications/pi-ui.app";

if (!process.argv.includes("--skip-build")) {
  execSync("pnpm tauri:build", { cwd: repoDir, stdio: "inherit" });
}
if (!existsSync(built)) {
  console.error(`[install] build output not found: ${built}`);
  process.exit(1);
}

try {
  execFileSync("osascript", ["-e", 'if application "pi-ui" is running then quit app "pi-ui"'], { stdio: "ignore" });
} catch {
  // not running / not scriptable: fine
}
// Give the app a moment to exit (it stops its server on the way out).
for (let i = 0; i < 20; i++) {
  try {
    execFileSync("pgrep", ["-x", "pi-ui"], { stdio: "ignore" });
  } catch {
    break; // no process left
  }
  execSync("sleep 0.25");
}

execFileSync("rm", ["-rf", target], { stdio: "inherit" });
execFileSync("ditto", [built, target], { stdio: "inherit" });
console.log(`[install] installed ${target}`);
