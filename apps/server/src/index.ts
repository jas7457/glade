/**
 * Server entry point: wires config, store, harness, AppService and the HTTP/WebSocket app.
 * Harnesses are registered here in a `HarnessRegistry` (I-064; `GLADE_HARNESS=fake` registers
 * the fake one instead of pi, for UI work). Sessions run in the harness that created them.
 * The desktop app runs a bundled copy of this file (see apps/desktop/scripts/bundle-server.mjs).
 * Several servers may share one data folder (I-062: `pnpm dev` next to the installed app): each
 * announces itself in `<dataDir>/servers/<pid>.json` (services/server-registry.ts), and session
 * leases + a locked, watched store (AppService, store/) keep them from stepping on each other.
 */
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { env, isTemporaryDir, LEGACY_APP_DIR_NAME, loadConfig, platformDataDir, startupBanner } from "./config.js";
import { AcpHarnessProvider, acpTranscriptsDir } from "./harness/acp/acp-harness.js";
import { FakeHarness } from "./harness/fake/fake-harness.js";
import { PiHarness } from "./harness/pi/pi-harness.js";
import { HarnessRegistry } from "./harness/registry.js";
import { createApp } from "./http/app.js";
import { AppService } from "./services/app-service.js";
import { FolderInfoService } from "./services/folder-info.js";
import { createSearchService } from "./services/search/create.js";
import { ServerRegistry } from "./services/server-registry.js";
import { migrateLegacyDataDir } from "./store/migrate-data-dir.js";
import { Store } from "./store/store.js";

const config = loadConfig();
const log = (msg: string) => console.log(`[glade] ${msg}`);

// I-059: the first start after the rename copies the old `pi-ui` data folder (left as a backup).
if (config.defaultDataDir) {
  try {
    const migrated = migrateLegacyDataDir(platformDataDir(LEGACY_APP_DIR_NAME), config.dataDir);
    if (migrated) log(`copied your data from ${migrated.from} to ${migrated.to} (the old folder is kept as a backup)`);
  } catch (err) {
    console.error(`[glade] could not copy the old pi-ui data folder: ${(err as Error).message}`);
  }
}

const serverKind = env("SERVER_KIND") ?? "dev";
const registry = new ServerRegistry(config.dataDir, { kind: serverKind, host: config.host, port: config.port });
registry.start();
for (const other of registry.others()) {
  log(`sharing the data folder with the ${other.kind} server on http://${other.host}:${other.port} (pid ${other.pid})`);
}
const store = new Store(config.dataDir);

// The first registered harness is the default unless the `agent.defaultHarness` setting names another.
// ACP agents the user added in Settings (I-119) are harnesses too, read from the settings on use;
// none by default, and an agent's process only starts with a chat's first prompt.
const acp = new AcpHarnessProvider(() => store.getSettings().harnesses.acp?.agents, {
  transcriptsDir: acpTranscriptsDir(config.dataDir),
  log: env("DEBUG") ? log : undefined,
});
const harnesses = new HarnessRegistry([], { preferred: () => store.getSettings().agent.defaultHarness, dynamic: () => acp.list() });
harnesses.register(
  config.harness === "fake"
    ? new FakeHarness(undefined, 30)
    : new PiHarness({
        config: () => store.getSettings().harnesses.pi,
        utilityCwd: config.scratchDir,
        subagents: () => store.getSettings().agent.subagents,
        log: env("DEBUG") ? log : undefined,
      }),
);

// `search` is created right after the service; the hook refreshes its index as runs settle.
let search: ReturnType<typeof createSearchService> | undefined;
const service = new AppService({
  store,
  harnesses,
  scratchDir: config.scratchDir,
  dataDir: config.dataDir,
  log,
  onRunEnd: (sessionId) => search?.onRunEnd(sessionId),
  registry,
});
// Sync, so it also runs on process.exit() and uncaught errors: other servers see us gone at once.
process.on("exit", () => {
  service.releaseLeases();
  registry.release();
});
search = createSearchService({ app: service, harnesses, dataDir: config.dataDir, log: env("DEBUG") ? log : undefined });
const folderInfo = new FolderInfoService({
  harness: () => harnesses.default(),
  scratchDir: config.scratchDir,
  projectPath: (id) => store.getProject(id)?.path,
});
const { app, injectWebSocket } = createApp({
  service,
  folderInfo,
  search,
  security: { mode: "loopback" },
  staticDir: config.staticDir ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
  // The installed app's bundle can be replaced while it runs (I-082): keep serving our own copy.
  snapshotStatic: serverKind === "desktop",
});

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  const host = info.family === "IPv6" ? `[${info.address}]` : info.address;
  registry.update({ host: info.address, port: info.port });
  // Agents reach the agent API here (GLADE_URL, I-037).
  service.setServerUrl(`http://${host}:${info.port}`);
  // I-051: make it obvious which data folder this server uses (and warn if it's temporary).
  const banner = startupBanner({
    url: `http://${host}:${info.port}`,
    dataDir: config.dataDir,
    harness: harnesses.list().map((h) => h.id).join(", "),
    kind: serverKind,
    sandbox: env("SANDBOX"),
    temporary: isTemporaryDir(config.dataDir),
  });
  for (const line of banner) (line.startsWith("⚠") ? console.warn : console.log)(`[glade] ${line}`);
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
    search?.dispose();
    await service.dispose();
    registry.release();
  } catch (err) {
    console.error("[glade] shutdown failed:", err);
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
