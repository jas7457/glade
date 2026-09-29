/**
 * Server entry point: wires config, store, harness, AppService and the HTTP/WebSocket app.
 * Harnesses are registered here in a `HarnessRegistry` (I-064; `GLADE_HARNESS=fake` registers
 * the fake one instead of pi, for UI work). Sessions run in the harness that created them.
 * The desktop app runs a bundled copy of this file (see apps/desktop/scripts/bundle-server.mjs).
 * Several servers may share one data folder (I-062: `pnpm dev` next to the installed app): each
 * announces itself in `<dataDir>/servers/<pid>.json` (services/server-registry.ts), and session
 * leases + the shared SQLite store and its event log (AppService, store/) keep them in step.
 *
 * I-121: app data lives in `<dataDir>/glade.db`. While a Glade from before the database runs on
 * the same folder, this server waits in a "Quit the older Glade first" state (http/blocked.ts)
 * without touching the data; then it imports the old JSON files once and starts normally.
 */
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { env, isTemporaryDir, LEGACY_APP_DIR_NAME, loadConfig, platformDataDir, startupBanner } from "./config.js";
import { AcpHarnessProvider } from "./harness/acp/acp-harness.js";
import type { AcpResumeState } from "./harness/acp/resume-store.js";
import { FakeHarness } from "./harness/fake/fake-harness.js";
import { PiHarness } from "./harness/pi/pi-harness.js";
import { HarnessRegistry } from "./harness/registry.js";
import { createApp } from "./http/app.js";
import { startBlockedServer } from "./http/blocked.js";
import { AppService } from "./services/app-service.js";
import { AuthService } from "./services/auth/auth-service.js";
import { lastServedPort, managesTransport, RemoteTransport } from "./services/transports/manager.js";
import { TailscaleTransport } from "./services/transports/tailscale.js";
import { FolderInfoService } from "./services/folder-info.js";
import { createSearchService } from "./services/search/create.js";
import { ServerRegistry } from "./services/server-registry.js";
import { migrateLegacyDataDir } from "./store/migrate-data-dir.js";
import { NewerSchemaError } from "./store/db/database.js";
import { olderServerMessage, recordSuccessfulStart } from "./store/startup.js";
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
// Sync, so it also runs on process.exit() and uncaught errors: other servers see us gone at once.
let releaseLeases = () => {};
process.on("exit", () => {
  releaseLeases();
  registry.release();
});

// I-121: never open (or import into) the database while an older Glade still writes the JSON files.
let listenPort = config.port;
if (registry.olderServers().length) {
  let message = olderServerMessage(registry.olderServers());
  console.warn(`[glade] ${message}`);
  let reportedUrl = false;
  const blocked = startBlockedServer(config.host, config.port, message, (port) => {
    listenPort = port;
    if (!reportedUrl) console.warn(`[glade] waiting on http://${config.host}:${port} until it has quit`);
    reportedUrl = true;
  });
  const stopBlocked = () => void blocked.close().then(() => process.exit(0));
  process.once("SIGINT", stopBlocked);
  process.once("SIGTERM", stopBlocked);
  if (config.exitOnStdinClose) {
    process.stdin.on("end", stopBlocked);
    process.stdin.resume();
  }
  while (registry.olderServers().length) {
    await new Promise((r) => setTimeout(r, 1000));
    const next = olderServerMessage(registry.olderServers());
    if (next !== message) blocked.setMessage((message = next));
  }
  await blocked.close();
  process.off("SIGINT", stopBlocked);
  process.off("SIGTERM", stopBlocked);
  log("the older Glade has quit; starting");
}

for (const other of registry.others()) {
  log(`sharing the data folder with the ${other.kind} server on http://${other.host}:${other.port} (pid ${other.pid})`);
}
let store: Store;
try {
  store = new Store(config.dataDir, undefined, { serverId: registry.id });
} catch (err) {
  console.error(`[glade] ${err instanceof NewerSchemaError ? err.message : `could not open the database: ${(err as Error).stack ?? err}`}`);
  process.exit(1);
}
if (store.jsonImport?.files.length) {
  const { counts, failed } = store.jsonImport;
  log(
    `imported your data into glade.db: ${counts.projects} projects, ${counts.workspaces} chats, ${counts.sessions} sessions ` +
      `(the JSON files are kept until this version has started a few times)`,
  );
  for (const f of failed) console.warn(`[glade] could not import ${f.file} (kept as it is): ${f.error}`);
}

// The first registered harness is the default unless the `agent.defaultHarness` setting names another.
// ACP agents the user added in Settings (I-119) are harnesses too, read from the settings on use;
// none by default, and an agent's process only starts with a chat's first prompt.
const acpResume = new Map<string, AcpResumeState>(); // until a new chat's record has its ref
const acp = new AcpHarnessProvider(() => store.getSettings().harnesses.acp?.agents, {
  resume: {
    load: (ref) => store.getResumeByRef<AcpResumeState>(ref) ?? acpResume.get(ref) ?? null,
    save: (ref, state) => {
      if (store.patchResumeByRef(ref, { ...state })) acpResume.delete(ref);
      else acpResume.set(ref, state);
    },
    delete: (ref) => acpResume.delete(ref),
  },
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
releaseLeases = () => {
  service.flushTranscripts();
  service.releaseLeases();
};
search = createSearchService({ app: service, harnesses, store, log: env("DEBUG") ? log : undefined });
const folderInfo = new FolderInfoService({
  harness: () => harnesses.default(),
  scratchDir: config.scratchDir,
  projectPath: (id) => store.getProject(id)?.path,
});
// I-125: where clients reach us and which loopback origins are our own: this server's port and
// its web dev server's (Vite: GLADE_WEB_PORT, 5317 for `pnpm dev`).
let listeningUrl: string | null = null;
let listeningPort: number | null = null;
const webPort = Number(env("WEB_PORT") ?? (serverKind === "desktop" ? NaN : 5317));
// I-127: remote devices come in over Tailscale Serve (https://<machine>.<tailnet>.ts.net). Only the
// desktop app runs `tailscale serve` unless GLADE_TAILSCALE_OWNER=1 (services/transports/manager.ts);
// GLADE_TAILSCALE=off leaves Tailscale out entirely (loopback addresses only, as before).
const transportManaged = managesTransport();
const remote: RemoteTransport | undefined =
  env("TAILSCALE") === "off"
    ? undefined
    : new RemoteTransport({
        transport: new TailscaleTransport({
          managed: transportManaged,
          gladePorts: () => {
            const ports = new Set(registry.list().map((s) => s.port));
            if (listeningPort !== null) ports.add(listeningPort);
            const last = lastServedPort(store.db);
            if (last !== null) ports.add(last);
            return [...ports];
          },
          log,
        }),
        db: store.db,
        managed: transportManaged,
        port: () => listeningPort,
        isEnabled: (): boolean => auth.isRemoteEnabled(),
        log,
      });
const auth = new AuthService({
  db: store.db,
  environmentId: service.environment.id,
  environmentName: () => service.getEnvironment().name,
  addresses: () => {
    const viaTransport = remote?.addresses() ?? [];
    return viaTransport.length ? viaTransport : listeningUrl ? [listeningUrl] : [];
  },
  hostnames: () => remote?.hostnames() ?? [],
  // I-143: code-free pairing only for requests from the host's own Tailscale account.
  tailscaleLogin: async () => (remote ? remote.ownLogin() : null),
});
const { app, injectWebSocket } = createApp({
  service,
  folderInfo,
  search,
  auth,
  remote,
  ownPorts: () => [...(listeningPort === null ? [] : [listeningPort]), ...(Number.isInteger(webPort) ? [webPort] : [])],
  staticDir: config.staticDir ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
  // The installed app's bundle can be replaced while it runs (I-082): keep serving our own copy.
  snapshotStatic: serverKind === "desktop",
});

const server = serve({ fetch: app.fetch, hostname: config.host, port: listenPort }, (info) => {
  const host = info.family === "IPv6" ? `[${info.address}]` : info.address;
  registry.update({ host: info.address, port: info.port });
  listeningUrl = `http://${host}:${info.port}`;
  listeningPort = info.port;
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
  // I-121: count the start (the old JSON files go after a few), then import every chat's harness
  // file into the store in the background.
  try {
    recordSuccessfulStart(store, registry, log);
  } catch (err) {
    console.warn(`[glade] could not record the start: ${(err as Error).message}`);
  }
  remote?.start();
  void service.startTranscriptImport().catch((err: Error) => console.warn(`[glade] importing conversations failed: ${err.message}`));
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
    auth.dispose();
    remote?.dispose();
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
