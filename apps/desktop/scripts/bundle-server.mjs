/**
 * Build step for the desktop app (Tauri `beforeBuildCommand`): builds the web app, bundles the
 * server into one ESM file with esbuild, and stages both in `apps/desktop/dist-bundle/`, which
 * tauri.conf.json ships as the `app/` resource folder:
 *
 *   app/server.mjs   — the whole server (hono, ws, protocol …), run with the user's own `node`
 *   app/web/         — the built web app, served by the server (GLADE_STATIC_DIR)
 *   app/pi-extension/glade-tools.ts — Glade's pi extension (I-116), loaded with `pi -e`; pi compiles
 *                      it itself (jiti), so it's copied as-is (self-contained, `node:` imports only)
 *   app/node_modules/node-pty/ — terminal tabs' pty (I-187): a native add-on, so it's left out of
 *                      the bundle (external) and copied next to it: its JS (`lib/`), `package.json`
 *                      and the macOS N-API prebuilds (arm64 + x64: `pty.node`, `spawn-helper`, made
 *                      executable). N-API, so they load in any Node the app finds (≥ 22.13).
 *
 * I-149: the server is stamped with the commit it's built from (sha, build time, local changes,
 * repo folder) via esbuild's `define` (`__GLADE_BUILD__`, read by apps/server/src/services/build-info.ts).
 */
import { execSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = join(desktopDir, "..", "..");
const outDir = join(desktopDir, "dist-bundle");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

console.log("[bundle] building web app…");
execSync("pnpm --filter @glade/web build", { cwd: repoDir, stdio: "inherit" });
const webDist = join(repoDir, "apps", "web", "dist");
if (!existsSync(join(webDist, "index.html"))) throw new Error(`web build missing: ${webDist}`);
cpSync(webDist, join(outDir, "web"), { recursive: true });

console.log("[bundle] stamping the build…");
const stamp = await buildStamp();
console.log(stamp ? `[bundle] built from ${stamp.shortCommit}${stamp.dirty ? " (with local changes)" : ""}` : "[bundle] not a git checkout: no build stamp");

console.log("[bundle] bundling server…");
await build({
  entryPoints: [join(repoDir, "apps", "server", "src", "index.ts")],
  outfile: join(outDir, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22", // Node ≥ 22.13 at runtime: `node:sqlite` (I-121) is a built-in, left external
  sourcemap: "linked",
  // ws optionally requires these native add-ons inside try/catch; they're not installed.
  // node-pty (I-187) is a native add-on: copied into app/node_modules below.
  external: ["bufferutil", "utf-8-validate", "node-pty"],
  // CommonJS deps (ws) call require() for Node built-ins, which ESM output doesn't have.
  banner: { js: "import { createRequire as __piCreateRequire } from 'node:module'; const require = __piCreateRequire(import.meta.url);" },
  define: { __GLADE_BUILD__: JSON.stringify(stamp) },
  logLevel: "info",
});
const piExtension = join(repoDir, "apps", "server", "src", "harness", "pi", "extension", "glade-tools.ts");
mkdirSync(join(outDir, "pi-extension"), { recursive: true });
cpSync(piExtension, join(outDir, "pi-extension", "glade-tools.ts"));
copyNodePty();
writeFileSync(join(outDir, "package.json"), JSON.stringify({ type: "module" }) + "\n");
console.log(`[bundle] done → ${outDir}`);

/** The git stamp of this checkout, computed by the server's own build-info.ts (compiled on the fly). */
async function buildStamp() {
  const tmp = join(outDir, ".build-info.mjs");
  await build({
    entryPoints: [join(repoDir, "apps", "server", "src", "services", "build-info.ts")],
    outfile: tmp,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "warning",
  });
  try {
    const { gitStamp } = await import(pathToFileURL(tmp).href);
    return gitStamp(repoDir, "release");
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** node-pty's runtime files (I-187): JS, package.json, license and the macOS prebuilds. */
function copyNodePty() {
  const serverRequire = createRequire(join(repoDir, "apps", "server", "package.json"));
  const src = dirname(serverRequire.resolve("node-pty/package.json"));
  const dest = join(outDir, "node_modules", "node-pty");
  mkdirSync(dest, { recursive: true });
  for (const file of ["package.json", "LICENSE"]) if (existsSync(join(src, file))) cpSync(join(src, file), join(dest, file));
  cpSync(join(src, "lib"), join(dest, "lib"), { recursive: true, filter: (path) => !path.endsWith(".test.js") && !path.endsWith(".map") });
  let prebuilds = 0;
  for (const arch of ["darwin-arm64", "darwin-x64"]) {
    const dir = join(src, "prebuilds", arch);
    if (!existsSync(dir)) continue;
    cpSync(dir, join(dest, "prebuilds", arch), { recursive: true });
    const helper = join(dest, "prebuilds", arch, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
    prebuilds++;
  }
  if (!prebuilds) throw new Error(`node-pty has no macOS prebuilds in ${src}`);
  console.log(`[bundle] node-pty copied (${prebuilds} prebuild${prebuilds === 1 ? "" : "s"})`);
}
