#!/usr/bin/env node
/**
 * A fake `tailscale` CLI for the website demo sandbox (I-209; `GLADE_TAILSCALE_CLI` points here), so
 * Settings → Remote Access shows a running tailnet with peers without touching the real Tailscale.
 * Answers only what Glade asks (services/transports/tailscale.ts):
 *
 *   tailscale status --json                      a running tailnet: this Mac ("Studio") + peers
 *   tailscale serve status --json                the serve config, kept in the state file
 *   tailscale serve --bg --https=443 <url>       sets the `/` handler
 *   tailscale serve --https=443 --set-path=/ off removes it
 *
 * State: `GLADE_FAKE_TAILSCALE_STATE` (JSON: `{ running, proxy }`); `running: false` reports a
 * stopped Tailscale (the demo turns it off while it pairs the iPhone simulator over loopback).
 */
import { readFileSync, writeFileSync } from "node:fs";

const file = process.env.GLADE_FAKE_TAILSCALE_STATE;
const read = () => {
  try {
    return { running: true, proxy: null, ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return { running: true, proxy: null };
  }
};
const save = (state) => file && writeFileSync(file, JSON.stringify(state));
const args = process.argv.slice(2);
const DNS = "studio.tail4f8e2.ts.net";
const state = read();
const peer = (host, dns, os, online, ip) => ({ HostName: host, DNSName: `${dns}.tail4f8e2.ts.net.`, OS: os, Online: online, TailscaleIPs: [ip] });

if (args[0] === "status" && args.includes("--json")) {
  if (!state.running) {
    console.log(JSON.stringify({ BackendState: "Stopped", Self: null, Peer: {}, TailscaleIPs: [] }));
  } else {
    console.log(
      JSON.stringify({
        BackendState: "Running",
        TailscaleIPs: ["100.101.42.7", "fd7a:115c:a1e0::e601:2a07"],
        CertDomains: [DNS],
        Self: { HostName: "Studio", DNSName: `${DNS}.`, OS: "macOS", Online: true, TailscaleIPs: ["100.101.42.7"], UserID: 1001 },
        User: { 1001: { LoginName: "demo@example.com", DisplayName: "Demo" } },
        Peer: {
          a: peer("MacBook Air", "macbook-air", "macOS", true, "100.88.12.40"),
          b: peer("iPhone", "iphone", "iOS", true, "100.91.3.18"),
          c: peer("homelab", "homelab", "linux", false, "100.70.9.2"),
        },
      }),
    );
  }
} else if (args[0] === "serve" && args[1] === "status") {
  const web = state.proxy ? { [`${DNS}:443`]: { Handlers: { "/": { Proxy: state.proxy } } } } : {};
  console.log(JSON.stringify(state.proxy ? { TCP: { 443: { HTTPS: true } }, Web: web } : {}));
} else if (args[0] === "serve" && args.includes("off")) {
  save({ ...state, proxy: null });
} else if (args[0] === "serve" && args.includes("--bg")) {
  save({ ...state, proxy: args.at(-1) });
  console.log(`Available within your tailnet:\n\nhttps://${DNS}/\n|-- proxy ${args.at(-1)}\n`);
} else if (args[0] === "version") {
  console.log("1.94.1\n  tailscale commit: demo");
} else {
  console.error(`fake tailscale: unsupported command: ${args.join(" ")}`);
  process.exit(1);
}
