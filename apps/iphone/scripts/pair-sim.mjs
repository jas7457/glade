#!/usr/bin/env node
// Pair the iPhone app in a simulator with a `pnpm dev:agent` sandbox, unattended (I-164):
// turns remote access on in the sandbox, makes a Share link, types it into the app's
// Connect → Paste Link sheet (through scripts/ios-sim.mjs + the UI hierarchy) and presses Allow
// on the sandbox's side. Start the sandbox with GLADE_TAILSCALE=off.
//
//   node apps/iphone/scripts/pair-sim.mjs --api http://127.0.0.1:<port>/api [--device "iPhone 18 Pro"]
//
// The app must be installed and showing Connect to a Device (first run), or Chats (then it goes
// through the + button).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const api = opt("--api");
const device = opt("--device", "iPhone 18 Pro");
if (!api) throw new Error("--api http://127.0.0.1:<port>/api is required");
const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = `/tmp/glade-pair-sim-${device.replace(/\W+/g, "-")}`;

const http = async (method, path, body) => {
  const r = await fetch(api + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return text ? JSON.parse(text) : null;
};
const sim = (...cmds) => {
  execFileSync("node", [join(repo, "scripts/ios-sim.mjs"), "--app", "io.github.jas7457.glade.iphone", "--device", device, "--out", out, "--settle", "1", ...cmds], { stdio: "inherit" });
  return readFileSync(join(out, `step-${cmds.length}.txt`), "utf8");
};
const hit = (tree, re) => {
  const line = tree.split("\n").find((l) => re.test(l));
  const m = line && /hitPoint: \{([\d.]+), ([\d.]+)\}/.exec(line);
  return m ? `${Math.round(+m[1])} ${Math.round(+m[2])}` : null;
};

await http("PATCH", "/auth/remote", { enabled: true });
const { link } = await http("POST", "/auth/invites");
// Right after a launch the web content can still be an opaque placeholder: look again.
let tree = sim("");
for (let i = 0; i < 4 && /isRemoteLeafPlaceholder/.test(tree); i++) {
  await new Promise((r) => setTimeout(r, 1500));
  tree = sim("");
}
if (!hit(tree, /label: 'Paste Link'/)) {
  const plus = hit(tree, /label: 'Connect to a Device'.*Button|Button.*label: 'Connect to a Device'/);
  if (!plus) throw new Error(`neither Connect nor the + button found; see ${out}/step-1.png`);
  tree = sim(`t ${plus}`);
}
const paste = hit(tree, /Button.*label: 'Paste Link'/);
if (!paste) throw new Error(`no Paste Link button; see ${out}`);
tree = sim(`t ${paste}`);
const field = hit(tree, /label: 'Pairing link'/);
if (!field) throw new Error(`no link field; see ${out}`);
tree = sim(`t ${field}`, `sender keyboard kbd ${link}`);
const connect = hit(tree, /Button.*label: 'Connect'(?!.*Disabled)/);
if (!connect) throw new Error(`no enabled Connect button; see ${out}`);
sim(`t ${connect}`);
for (let i = 0; i < 20; i++) {
  const pending = await http("GET", "/auth/pending");
  if (pending?.length) {
    await http("POST", `/auth/pending/${pending[0].id}`, { allow: true });
    console.log(`allowed ${pending[0].deviceName} (${pending[0].deviceKind})`);
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
await new Promise((r) => setTimeout(r, 3000));
sim("");
console.log(`paired; screenshot ${out}/step-1.png`);
