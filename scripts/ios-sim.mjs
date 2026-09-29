#!/usr/bin/env node
// Drive the iOS simulator through Xcode's own MCP server (`xcrun mcpbridge`, Xcode 26.3+):
// tap / swipe / type / press buttons, and save a screenshot + UI hierarchy after each step.
// Used by agents working on the iPhone app (docs/design/iphone-app.md §3). Needs Xcode running
// and the agent approved once in Xcode (the user clicks Allow; see the doc).
//
//   node scripts/ios-sim.mjs [--app <bundleId>] [--device "iPhone 18 Pro"] [--out <dir>] [--settle <s>] [cmd ...]
//
// Each cmd is one Xcode interaction command ("" = just capture): `t 201 498` tap, `d x y` double
// tap, `t x1 y1 f x2 y2 0.3` swipe, `sender keyboard kbd hello\u{000A}` type, `b h` home,
// `w 0.5` wait, `orientation landscapeLeft`. No cmds = one capture. Coordinates are points
// (iPhone 18 Pro: 402×874), the same as CSS px in the WebView (y includes the status bar area
// only if the page draws under it). Output: <out>/step-N.png and step-N.txt (the hierarchy);
// the paths are printed. Web content inside a WKWebView shows up as an opaque
// `RemotePlaceholder` in the hierarchy, so find targets from the screenshot or the DOM.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const app = opt("--app", undefined);
const device = opt("--device", "iPhone 18 Pro");
const out = opt("--out", "/tmp/glade-ios-sim");
const settle = Number(opt("--settle", "0.6"));
const cmds = argv.length ? argv : [""];
mkdirSync(out, { recursive: true });

const p = spawn("xcrun", ["mcpbridge"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
let id = 0;
const waits = new Map();
p.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    try {
      const m = JSON.parse(line);
      waits.get(m.id)?.(m);
    } catch {
      /* not JSON-RPC */
    }
  }
});
const rpc = (method, params, ms = 120_000) =>
  new Promise((resolve, reject) => {
    const i = ++id;
    const timer = setTimeout(() => reject(new Error(`${method} timed out after ${ms / 1000}s`)), ms);
    waits.set(i, (m) => (clearTimeout(timer), resolve(m)));
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
  });
const call = async (name, args, ms) => {
  const r = await rpc("tools/call", { name, arguments: args }, ms);
  const text = r.result?.content?.map((c) => c.text).join("\n") ?? JSON.stringify(r);
  if (r.result?.isError || /"type":"error"/.test(text)) throw new Error(`${name}: ${text}`);
  return text;
};

const key = `Glade Sim ${Date.now()}`; // session names can't be reused
let started = false;
let exitCode = 0;
try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "glade-ios-sim", version: "1" } }, 30_000);
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await call("DeviceInteractionStartSession", { sessionIdentifier: key, deviceIdentifier: device }, 240_000);
  started = true;
  const synth = async (cmd, activate) =>
    JSON.parse(await call("DeviceInteractionSynthesize", { interactSessionKey: key, interactionCommand: cmd, ...(activate && app ? { activationBundleId: app } : {}) }));
  for (const [n, cmd] of cmds.entries()) {
    const first = await synth(cmd, n === 0);
    // The capture right after an event can precede the repaint: settle, then capture again.
    const r = cmd && settle > 0 ? await synth(`w ${settle}`, false) : first;
    const png = join(out, `step-${n + 1}.png`);
    const txt = join(out, `step-${n + 1}.txt`);
    copyFileSync(r.screenshotPath, png); // Xcode deletes its artifacts when the session ends
    writeFileSync(txt, readFileSync(r.hierarchyPath, "utf8"));
    console.log(`step ${n + 1} ${JSON.stringify(cmd)} → ${png} (${r.applicationState ?? "?"}) hierarchy ${txt}`);
  }
} catch (e) {
  console.error(String(e?.message ?? e));
  exitCode = 1;
} finally {
  if (started) await call("DeviceInteractionEndSession", { interactionSessionKey: key }, 60_000).catch(() => {});
  p.kill();
  process.exit(exitCode);
}
