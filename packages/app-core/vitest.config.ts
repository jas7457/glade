import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";
import { dedupe, testAliases, testInlineDeps, testSetupFile } from "./vite.shared.ts";

export default defineConfig({
  plugins: [preact()],
  resolve: {
    alias: testAliases,
    // Prefer ESM builds (react-remove-scroll & co. ship CJS in "main").
    mainFields: ["module", "jsnext:main", "jsnext"],
    dedupe,
  },
  test: {
    name: "app-core",
    environment: "jsdom",
    setupFiles: [testSetupFile],
    css: false,
    server: { deps: { inline: testInlineDeps } },
  },
});
