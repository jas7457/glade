import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";
import { dedupe, testAliases, testInlineDeps, testSetupFile } from "../../packages/app-core/vite.shared.ts";

export default defineConfig({
  plugins: [preact()],
  resolve: {
    // `~/…` = this app; the rest (app core, one preact/react-router) is shared with the app core's tests.
    alias: [{ find: "~", replacement: fileURLToPath(new URL("./src", import.meta.url)) }, ...testAliases],
    mainFields: ["module", "jsnext:main", "jsnext"],
    dedupe,
  },
  test: {
    name: "iphone",
    environment: "jsdom",
    setupFiles: [testSetupFile],
    css: false,
    server: { deps: { inline: testInlineDeps } },
  },
});
