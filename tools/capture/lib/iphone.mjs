/**
 * iPhone captures (I-209) in the iOS simulator, paired with the demo sandbox (never a real iPhone
 * or the user's tailnet): builds a debug simulator app (apps/iphone/scripts/sim.mjs), installs it
 * fresh, launches it with `--glade-fake-voice` (the simulator's speech recognition doesn't start,
 * so conversation mode uses the app's fake voice engine), pairs it over loopback
 * (apps/iphone/scripts/pair-sim.mjs, with the demo's fake Tailscale switched off meanwhile so the
 * pairing link names the loopback address), then drives it with scripts/ios-sim.mjs (Xcode's MCP
 * bridge; Xcode must be running) and saves full-resolution screenshots with `simctl io`.
 *
 * Dark appearance and a clean status bar (9:41, full battery) are set on the simulator for the run
 * and reset afterwards; the simulator is shut down at the end.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./sandbox.mjs";

const BUNDLE_ID = "io.github.jas7457.glade.iphone";
const xcrun = (...args) => execFileSync("xcrun", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The udid of an available simulator named `name`. */
function deviceId(name) {
  const { devices } = JSON.parse(xcrun("simctl", "list", "devices", "available", "-j"));
  const device = Object.values(devices).flat().find((d) => d.name === name);
  if (!device) throw new Error(`no simulator named "${name}" (xcrun simctl list devices)`);
  return device.udid;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs the iPhone captures. `sandbox` = startDemoSandbox()'s result; `chats` = its seeded chats'
 * titles to tap. Returns the written files with their sizes.
 */
export async function captureIphone({ sandbox, out, prompts, device = "iPhone 18 Pro", build = true, log = console.log }) {
  const udid = deviceId(device);
  const results = [];
  const simOut = "/tmp/glade-capture-iphone";
  /** Runs scripts/ios-sim.mjs commands; returns the last step's UI hierarchy. */
  const sim = (...cmds) => {
    execFileSync("node", [join(REPO_ROOT, "scripts/ios-sim.mjs"), "--app", BUNDLE_ID, "--device", device, "--out", simOut, "--settle", "1.2", ...cmds], { stdio: "ignore" });
    return readFileSync(join(simOut, `step-${cmds.length}.txt`), "utf8");
  };
  const hit = (tree, re) => {
    const line = tree.split("\n").find((l) => re.test(l));
    const m = line && /hitPoint: \{([\d.]+), ([\d.]+)\}/.exec(line);
    if (!m) throw new Error(`nothing matching ${re} on screen (see ${simOut})`);
    return `${Math.round(+m[1])} ${Math.round(+m[2])}`;
  };
  const shot = (name) => {
    const path = join(out, `${name}.png`);
    xcrun("simctl", "io", udid, "screenshot", path);
    results.push({ path, bytes: statSync(path).size });
    log(`saved ${name}.png`);
  };

  try {
    xcrun("simctl", "boot", udid);
  } catch {
    /* already booted */
  }
  xcrun("simctl", "bootstatus", udid, "-b");
  const appearance = xcrun("simctl", "ui", udid, "appearance").trim() || "light";
  xcrun("simctl", "ui", udid, "appearance", "dark");
  xcrun("simctl", "status_bar", udid, "override", "--time", "9:41", "--dataNetwork", "wifi", "--wifiMode", "active", "--wifiBars", "3", "--cellularMode", "active", "--cellularBars", "4", "--batteryState", "discharging", "--batteryLevel", "100");
  try {
    // A fresh install: no saved Macs from earlier runs.
    try {
      xcrun("simctl", "uninstall", udid, BUNDLE_ID);
    } catch {
      /* not installed */
    }
    log(build ? "building the iPhone app for the simulator…" : "installing the last simulator build…");
    execFileSync("node", [join(REPO_ROOT, "apps/iphone/scripts/sim.mjs"), "--device", udid, ...(build ? [] : ["--no-build"]), "--", "--glade-fake-voice"], { stdio: "inherit" });
    await sleep(3000);

    // Pair over loopback: with Tailscale "off" the link carries http://127.0.0.1:<port>.
    const tailscale = join(sandbox.dir, "tailscale.json");
    writeFileSync(tailscale, JSON.stringify({ running: false }));
    await fetch(`${sandbox.api}/auth/remote`).catch(() => {});
    try {
      // Right after a fresh install the app's content can take a while to show: one retry, relaunched.
      for (let attempt = 1; ; attempt++) {
        try {
          execFileSync("node", [join(REPO_ROOT, "apps/iphone/scripts/pair-sim.mjs"), "--api", sandbox.api, "--device", device], { stdio: ["ignore", "ignore", "inherit"] });
          break;
        } catch (err) {
          if (attempt >= 2) throw err;
          log("pairing didn't go through; relaunching the app and trying again");
          xcrun("simctl", "launch", "--terminate-running-process", udid, BUNDLE_ID, "--glade-fake-voice");
          await sleep(5000);
        }
      }
    } finally {
      writeFileSync(tailscale, JSON.stringify({ running: true }));
    }
    await sleep(2500);

    // The chat list.
    let tree = sim("");
    shot("iphone-list");

    // A chat: the hero's chat (sub-agent cards, a summary).
    tree = sim(`t ${hit(tree, /Button.*label: 'Retry flaky checks with backoff/)}`, "w 1.5");
    shot("iphone-chat");

    // Conversation mode: ask out loud in the audit chat, capture the reply being read.
    tree = sim(`t ${hit(tree, /Button.*label: 'Chats'/)}`);
    tree = sim(`t ${hit(tree, /Button.*label: 'Pre-1\.0 audit/)}`, "w 1");
    tree = sim(`t ${hit(tree, /Button.*label: 'Voice mode'/)}`);
    sim(`t ${hit(tree, /label: 'Say \(debug\)'/)}`, `sender keyboard kbd ${prompts.voice}\u{000A}`, "w 3.6");
    shot("iphone-voice");
    // The same moment in the chat: the word being read is highlighted in the reply.
    tree = sim("w 0.1");
    sim(`t ${hit(tree, /Button.*label: 'Back to chat'/)}`);
    shot("iphone-voice-chat");
    await sleep(15_000); // let the reading finish
  } finally {
    try {
      xcrun("simctl", "terminate", udid, BUNDLE_ID);
    } catch {}
    try {
      xcrun("simctl", "status_bar", udid, "clear");
      if (appearance === "light" || appearance === "dark") xcrun("simctl", "ui", udid, "appearance", appearance);
      xcrun("simctl", "shutdown", udid);
    } catch {}
  }
  return results;
}
