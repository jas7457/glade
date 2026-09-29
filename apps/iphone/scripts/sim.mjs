#!/usr/bin/env node
// Build the iPhone app for the simulator, install it and launch it (docs/design/iphone-app.md §3).
//
//   pnpm --filter @glade/iphone sim [--no-build] [--device <udid|booted>] [-- <launch args>]
//
// Output of the build goes to /tmp/glade-iphone-build[-<worktree>].log (only errors are printed). Then use
// `node scripts/ios-sim.mjs --app io.github.jas7457.glade.iphone …` (repo root) to tap and screenshot.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, openSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE_ID = "io.github.jas7457.glade.iphone";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const noBuild = argv.includes("--no-build");
const di = argv.indexOf("--device");
const device = di >= 0 ? argv[di + 1] : "booted";
const dd = argv.indexOf("--");
const launchArgs = dd >= 0 ? argv.slice(dd + 1) : [];
const app = join(root, "src-tauri/gen/apple/build/arm64-sim/Glade.app");
// One log per checkout (worktrees build in parallel).
const checkout = basename(join(root, "../.."));
const log = checkout === "glade" ? "/tmp/glade-iphone-build.log" : `/tmp/glade-iphone-build-${checkout}.log`;

if (!noBuild) {
  const env = { ...process.env, LANG: "en_US.UTF-8", PATH: `${join(homedir(), ".cargo/bin")}:${process.env.PATH}` };
  // Tauri moves the archived app here and fails if the previous one is still there.
  rmSync(app, { recursive: true, force: true });
  const out = openSync(log, "w");
  const t0 = Date.now();
  const r = spawnSync("pnpm", ["tauri", "ios", "build", "--target", "aarch64-sim", "--debug", "--ci"], { cwd: root, env, stdio: ["ignore", out, out] });
  const text = execFileSync("grep", ["-nE", "error(\\[|:)|BUILD (SUCC|FAIL)", log], { encoding: "utf8" }).trim();
  console.log(`build ${r.status === 0 ? "ok" : "FAILED"} in ${Math.round((Date.now() - t0) / 1000)}s (log: ${log})\n${text}`);
  if (r.status !== 0) process.exit(1);
}
if (!existsSync(app)) throw new Error(`no build at ${app}`);
if (device !== "booted") spawnSync("xcrun", ["simctl", "boot", device], { stdio: "ignore" });
execFileSync("xcrun", ["simctl", "install", device, app], { stdio: "inherit" });
execFileSync("xcrun", ["simctl", "launch", "--terminate-running-process", device, BUNDLE_ID, ...launchArgs], { stdio: "inherit" });
