/**
 * `pnpm tauri:install [--skip-build]`: build the desktop app and put it in /Applications/Glade.app
 * (ad-hoc signed by the build; local use only), then re-register it with LaunchServices so the
 * Dock / app switchers don't keep a stale icon.
 *
 * I-082: a running Glade is **not** quit. The new bundle is copied next to the installed one and
 * swapped in with renames, so the running app keeps its already-loaded files (its server serves
 * the web app from a copy taken at startup) and the next launch starts the new version.
 *
 * I-197: the running Glade notices the new build in its bundle (`app/build.json`) and restarts into
 * it on its own: right away when none of its chats are working, else as soon as they all finish
 * (an agent running this from a chat is one of them, so it waits for that turn to end).
 *
 * I-059 (renamed from pi-ui): the pre-rename `/Applications/pi-ui.app` is removed once Glade.app is
 * installed and pi-ui isn't running (its data folder stays; Glade copies it on first start).
 *
 * `GLADE_INSTALL_TARGET=/some/dir/Glade.app` installs somewhere else (agents testing Update Now,
 * I-154, with a throwaway bundle; never the user's /Applications/Glade.app). The pre-rename
 * cleanup only runs for the default target.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = join(desktopDir, "..", "..");
const built = join(desktopDir, "src-tauri", "target", "release", "bundle", "macos", "Glade.app");
const defaultTarget = "/Applications/Glade.app";
const target = process.env.GLADE_INSTALL_TARGET ? resolve(process.env.GLADE_INSTALL_TARGET) : defaultTarget;
/** Staging copies live next to the target (same volume, so the swap is a pair of renames). */
const incoming = join(dirname(target), `.${basename(target)}.incoming`);
const outgoing = join(dirname(target), `.${basename(target)}.outgoing`);
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

/** The installed app (by its path): `tauri dev`'s "Glade (dev).app" runs from target/debug. */
function running(app) {
  try {
    // `-a`: include ancestors, since installs usually run from a chat inside Glade itself.
    execFileSync("pgrep", ["-af", `${app}/Contents/MacOS/`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Leftovers from an interrupted install.
rmSync(incoming, { recursive: true, force: true });
rmSync(outgoing, { recursive: true, force: true });

execFileSync("ditto", [built, incoming], { stdio: "inherit" });
if (existsSync(target)) renameSync(target, outgoing);
renameSync(incoming, target);
// The running app (if any) keeps using the files it already opened; nothing loads from the old
// bundle by path afterwards, so the old copy can go right away.
rmSync(outgoing, { recursive: true, force: true });
execFileSync("touch", [target]);
try {
  execFileSync(lsregister, ["-f", target], { stdio: "ignore" });
} catch {
  // best effort: LaunchServices also notices the new bundle on first launch
}
console.log(`[install] installed ${target}`);
console.log(
  running(target)
    ? "[install] Glade is running: it restarts into the new version on its own, right away or as soon as its working chats finish (Cancel / Restart Now in its window)."
    : "[install] Open Glade to use the new version.",
);

// I-059: the pre-rename app is replaced by Glade.app; its data folder is left alone (a backup).
if (target === defaultTarget && existsSync(legacyTarget) && !running(legacyTarget)) {
  try {
    execFileSync(lsregister, ["-u", legacyTarget], { stdio: "ignore" });
  } catch {
    // best effort
  }
  rmSync(legacyTarget, { recursive: true, force: true });
  console.log(`[install] removed the old ${legacyTarget} (its data folder stays; Glade copies it on first start)`);
}
