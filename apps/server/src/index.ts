/**
 * Server entry point: wires config, store, harness, AppService and the HTTP/WebSocket app.
 * Harnesses are registered here (`PI_UI_HARNESS=fake` selects the fake one for UI work).
 * The desktop app runs a bundled copy of this file (see apps/desktop/scripts/bundle-server.mjs).
 */
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { FakeHarness } from "./harness/fake/fake-harness.js";
import { PiHarness } from "./harness/pi/pi-harness.js";
import type { AgentHarness } from "./harness/types.js";
import { createApp } from "./http/app.js";
import { AppService } from "./services/app-service.js";
import { Store } from "./store/store.js";

const config = loadConfig();
const log = (msg: string) => console.log(`[pi-ui] ${msg}`);
const store = new Store(config.dataDir);

const harness: AgentHarness =
  config.harness === "fake"
    ? new FakeHarness(undefined, 30)
    : new PiHarness({
        config: () => {
          const { piPath, extraArgs, autoCompaction, autoRetry } = store.getSettings().agent;
          return { piPath, extraArgs, autoCompaction, autoRetry };
        },
        utilityCwd: config.scratchDir,
        log: process.env.PI_UI_DEBUG ? log : undefined,
      });

const service = new AppService({ store, harness, scratchDir: config.scratchDir, log });
const { app, injectWebSocket } = createApp({
  service,
  security: { mode: "loopback" },
  staticDir: config.staticDir ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
});

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  const host = info.family === "IPv6" ? `[${info.address}]` : info.address;
  log(`listening on http://${host}:${info.port} (harness: ${harness.id}, data: ${config.dataDir})`);
});
injectWebSocket(server);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received, shutting down`);
  const force = setTimeout(() => process.exit(1), 5000);
  force.unref();
  try {
    server.close();
    await service.dispose();
  } catch (err) {
    console.error("[pi-ui] shutdown failed:", err);
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
if (config.exitOnStdinClose) {
  // The desktop app holds our stdin; if it exits or crashes, the pipe closes and we follow.
  process.stdin.on("end", () => void shutdown("stdin closed"));
  process.stdin.on("error", () => void shutdown("stdin closed"));
  process.stdin.resume();
}
