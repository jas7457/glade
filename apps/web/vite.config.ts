import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { appCoreAlias, dedupe } from "../../packages/app-core/vite.shared.ts";

/** `GLADE_<name>`, else the pre-rename `PI_UI_<name>` (I-059; see apps/server/src/config.ts `env`). */
const env = (name: string): string | undefined => process.env[`GLADE_${name}`] || process.env[`PI_UI_${name}`] || undefined;

const serverPort = Number(env("PORT") ?? 4317);
// Sandboxes (`pnpm dev:agent`) run Vite on their own port; the user's `pnpm dev` keeps 5317.
const webPort = Number(env("WEB_PORT") ?? 5317);

export default defineConfig({
  plugins: [preact(), tailwindcss()],
  resolve: {
    // `@/…` = this app (the desktop layout); `@glade/app-core/…` = the shared client core.
    alias: [{ find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) }, appCoreAlias],
    dedupe,
  },
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": { target: `http://127.0.0.1:${serverPort}`, changeOrigin: false },
      "/ws": { target: `ws://127.0.0.1:${serverPort}`, ws: true },
    },
  },
});
