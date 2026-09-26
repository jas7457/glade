/**
 * `tauri dev` beforeDevCommand: make sure the API server (:4317) and the Vite dev server (:5317)
 * are running. Ones that are already up (e.g. your own `pnpm dev`) are reused and left alone;
 * missing ones are started here and stopped again when `tauri dev` exits.
 * The process stays alive either way, since Tauri treats an exiting beforeDevCommand as done.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function isListening(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });
}

const targets = [
  { name: "server", port: 4317, filter: "@pi-ui/server" },
  { name: "web", port: 5317, filter: "@pi-ui/web" },
];

const children = [];
for (const t of targets) {
  if (await isListening(t.port)) {
    console.log(`[tauri:dev] ${t.name} already running on :${t.port}, reusing it`);
    continue;
  }
  console.log(`[tauri:dev] starting ${t.name} on :${t.port}`);
  children.push(spawn("pnpm", ["--filter", t.filter, "dev"], { cwd: repoDir, stdio: "inherit" }));
}

const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);
for (const c of children) c.on("exit", (code) => console.log(`[tauri:dev] dev server exited (${code ?? "signal"})`));
setInterval(() => {}, 1 << 30);
