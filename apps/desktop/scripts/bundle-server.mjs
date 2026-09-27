/**
 * Build step for the desktop app (Tauri `beforeBuildCommand`): builds the web app, bundles the
 * server into one ESM file with esbuild, and stages both in `apps/desktop/dist-bundle/`, which
 * tauri.conf.json ships as the `app/` resource folder:
 *
 *   app/server.mjs   — the whole server (hono, ws, protocol …), run with the user's own `node`
 *   app/web/         — the built web app, served by the server (GLADE_STATIC_DIR)
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

console.log("[bundle] bundling server…");
await build({
  entryPoints: [join(repoDir, "apps", "server", "src", "index.ts")],
  outfile: join(outDir, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  // ws optionally requires these native add-ons inside try/catch; they're not installed.
  external: ["bufferutil", "utf-8-validate"],
  // CommonJS deps (ws) call require() for Node built-ins, which ESM output doesn't have.
  banner: { js: "import { createRequire as __piCreateRequire } from 'node:module'; const require = __piCreateRequire(import.meta.url);" },
  logLevel: "info",
});
writeFileSync(join(outDir, "package.json"), JSON.stringify({ type: "module" }) + "\n");
console.log(`[bundle] done → ${outDir}`);
