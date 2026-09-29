/**
 * The iPhone app's web bundle (docs/design/iphone-app.md §4.1). The phone screens live in `src/`
 * (`~/…`); the shared client core comes from `@glade/app-core/…` (packages/app-core, §6 step 7).
 *
 * `pnpm dev` serves it on :5327 for Chrome at phone size; `pnpm tauri ios build` bundles `dist/`
 * into the app (no dev server needed at runtime: the app is a pure client of remote Glades).
 */
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { appCoreAlias, dedupe } from "../../packages/app-core/vite.shared.ts";

const port = Number(process.env.GLADE_IPHONE_PORT ?? 5327);

export default defineConfig({
  plugins: [preact(), tailwindcss()],
  resolve: {
    alias: [appCoreAlias, { find: "~", replacement: fileURLToPath(new URL("./src", import.meta.url)) }],
    // One copy of preact / signals for both folders' imports.
    dedupe,
  },
  // Tauri serves the bundle from its own scheme; relative asset paths keep it portable.
  base: "./",
  clearScreen: false,
  build: { target: "safari17", outDir: "dist", emptyOutDir: true },
  server: { host: "127.0.0.1", port, strictPort: true },
});
